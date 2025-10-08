import {Client, directory, crypto} from "acme-client";
import * as fs from "fs/promises";
import {X509Certificate, createHash, randomBytes, webcrypto} from "node:crypto";
import {createSecureContext, SecureContext} from "node:tls";
import {
    BasicConstraintsExtension,
    ExtendedKeyUsageExtension,
    KeyUsagesExtension,
    X509CertificateGenerator,
    SubjectAlternativeNameExtension, KeyUsageFlags,
    Extension,
} from "@peculiar/x509";
import { AsnSerializer, OctetString } from "@peculiar/asn1-schema";
import {createServer, Server} from "node:http";

export async function generateAlpnChallengeCert(
    domain: string,
    keyAuthorization: string
): Promise<{ certPem: string; keyPem: string }> {
    const digest = createHash('sha256').update(keyAuthorization, 'ascii').digest(); // Buffer
    const derDigest = AsnSerializer.serialize(new OctetString(digest));

    // Generate a key pair via WebCrypto (or Node Crypto)
    // @peculiar/x509 expects a CryptoKey; in Node, you can use subtle crypto via polyfill or via @peculiar/webcrypto
    // For simplicity, assume you obtain key pair in WebCrypto form:
    const keyPair = await webcrypto.subtle.generateKey(
        {
            name: "RSASSA-PKCS1-v1_5",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]), // 65537
            hash: "SHA-256",
        },
        true, // extractable
        ["sign", "verify"]
    );

    // Build certificate
    const cert = await X509CertificateGenerator.createSelfSigned({
        serialNumber: randomBytes(16).toString('hex'),
        name: `CN=${domain}`,
        keys: keyPair as any,
        notBefore: new Date(Date.now() - 5 * 60 * 1000),
        notAfter: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        extensions: [
            new BasicConstraintsExtension(false, undefined, true),
            new KeyUsagesExtension(KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment, true),
            new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], true),  // serverAuth OID
            new SubjectAlternativeNameExtension([{ type: 'dns', value: domain }], false),
            new Extension('1.3.6.1.5.5.7.1.31', true, derDigest)
        ]
    });

    const certPem = cert.toString('pem');
    const rawPrivateKey = await webcrypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const keyPem = [
        `-----BEGIN PRIVATE KEY-----`,
        Buffer.from(rawPrivateKey).toString("base64").match(/.{1,64}/g)!.join("\n"),
        `-----END PRIVATE KEY-----`,
    ].join("\n");

    return { certPem, keyPem };
}

export type LetsEncryptACMEConfig = {
    challengeType: "http-01" | "tls-alpn-01",
    httpListenPort?: number,
    httpListenAddress?: string,
    addAlpnChallenge?: (domain: string, secureContext: SecureContext) => void,
    removeAlpnChallenge?: (domain: string) => void
};

export class LetsEncryptACME {

    readonly hostnames: string[];
    readonly keyFile: string;
    readonly certFile: string;
    readonly renewBuffer: number;

    renewCallback: (key: Buffer, cert: Buffer) => void;
    config: LetsEncryptACMEConfig;
    client: Client;

    constructor(
        hostnames: string[],
        keyFile: string,
        certFile: string,
        config: LetsEncryptACMEConfig,
        renewBuffer: number = 14*24*60*60*1000
    ) {
        this.hostnames = hostnames;
        this.keyFile = keyFile;
        this.certFile = certFile;
        if(config.challengeType==="http-01") {
            if(config.httpListenPort==null) throw new Error("Http listen port needs to be specified for http-01 challenge type");
        } else if(config.challengeType==="tls-alpn-01") {
            if(config.addAlpnChallenge==null || config.removeAlpnChallenge==null) throw new Error("ALPN challenge add/remove must be specified for tls-alpn-01 challenge type");
        } else {
            throw new Error("Unknown challenge type");
        }
        this.config = config;
        this.renewBuffer = renewBuffer;
    }

    async init(
        renewCallback: (key: Buffer, cert: Buffer) => void
    ) {
        this.renewCallback = renewCallback;

        this.client = new Client({
            directoryUrl: directory.letsencrypt.production,
            accountKey: await crypto.createPrivateKey()
        });

        const existingKey = await fs.readFile(this.keyFile).catch(e => null);
        const existingCert = await fs.readFile(this.certFile).catch(e => null);

        const promise = this.renewOrCreate();

        if(existingKey==null || existingCert==null) {
            await promise;
        } else {
            promise.catch(e => {
                console.log("Certificate renewal error: ", e);
                console.error(e);
            });
            if(this.renewCallback!=null) this.renewCallback(existingKey, existingCert);
        }

        setInterval(() => this.renewOrCreate().catch(e => {
            console.log("Certificate renewal error: ", e);
            console.error(e);
        }), 4*60*60*1000); //Check certificate expiry every 4 hours
    }

    private getCertTlsAlpn01(csr: Buffer): Promise<string> {
        return this.client.auto({
            csr,
            // email: 'test@example.com',
            termsOfServiceAgreed: true,
            challengePriority: ['tls-alpn-01'],
            challengeCreateFn: async (authz, _challenge, _keyAuthorization) => {
                const domain = authz.identifier.value;
                // generate certificate
                const { certPem, keyPem } = await generateAlpnChallengeCert(domain, _keyAuthorization);
                console.log(`[ACME]: Adding ALPN challenge for ${domain}, authorization: ${_keyAuthorization}`);
                this.config.addAlpnChallenge(domain, createSecureContext({
                    key: keyPem,
                    cert: certPem
                }));
            },
            challengeRemoveFn: (authz, challenge) => {
                const domain = authz.identifier.value;
                console.log(`[ACME]: Removing ALPN challenge for ${domain}`);
                this.config.removeAlpnChallenge(domain);
                return Promise.resolve();
            }
        });
    }

    private async getCertHttp01(csr: Buffer): Promise<string> {
        let httpServer: Server;
        let httpServerCreatePromise: Promise<void>;
        const challenges: {[challengeToken: string]: string} = {};

        return await this.client.auto({
            csr,
            // email: 'test@example.com',
            termsOfServiceAgreed: true,
            challengePriority: ['http-01'],
            challengeCreateFn: (authz, _challenge, _keyAuthorization) => {
                challenges[_challenge.token] = _keyAuthorization;
                if(httpServerCreatePromise!=null) return httpServerCreatePromise;
                httpServer = createServer((req, res) => {
                    if (req.url.match(/\/\.well-known\/acme-challenge\/.+/)) {
                        const token = req.url.split('/').pop();
                        console.log(`[ACME]: Received challenge request for token=${token}`);

                        const keyAuthorization = challenges[token];
                        if(keyAuthorization==null) {
                            res.writeHead(404);
                            res.end();
                            return;
                        }

                        res.writeHead(200);
                        res.end(keyAuthorization);
                        return;
                    }

                    /* HTTP 302 redirect */
                    res.writeHead(302, { Location: `https://${req.headers.host}${req.url}` });
                    res.end();
                });

                return httpServerCreatePromise = new Promise<void>((resolve, reject) => {
                    httpServer.on("error", e => reject(e));
                    httpServer.listen(this.config.httpListenPort, this.config.httpListenAddress ?? "0.0.0.0", resolve);
                });
            },
            challengeRemoveFn: (authz, challenge) => {
                delete challenges[challenge.token];
                if(Object.keys(challenges).length!==0) return Promise.resolve();
                return new Promise<void>((resolve, reject) => httpServer.close(err => err==null ? resolve() : reject(err)));
            }
        });
    }

    async renewOrCreate() {
        console.log("[ACME]: Renew or create cert...");
        const existingCert = await fs.readFile(this.certFile).catch(e => null);
        const existingKey = await fs.readFile(this.keyFile).catch(e => null);

        if(existingKey!=null && existingCert!=null) {
            const certificateData = new X509Certificate(existingCert);
            const certificateExpiry = new Date(certificateData.validTo).getTime();
            if(certificateExpiry-Date.now()>this.renewBuffer) {
                console.log("[ACME]: Not renewing, old certificate still valid!");
                return;
            }
        }

        if(existingKey==null) console.log("[ACME]: Creating new CSR key!");

        const [key, csr] = await crypto.createCsr({
            commonName: this.hostnames[0],
            altNames: this.hostnames.slice(1)
        }, existingKey);

        if(existingKey==null) console.log("[ACME]: Requesting certificate!");

        const cert = this.config.challengeType==="tls-alpn-01" ? await this.getCertTlsAlpn01(csr) : await this.getCertHttp01(csr);

        console.log("[ACME]: Certificate request success!");

        const certBuffer = Buffer.from(cert);
        await fs.writeFile(this.keyFile, key);
        await fs.writeFile(this.certFile, certBuffer);

        console.log("[ACME]: Key & certificate written to the disk!");

        if(this.renewCallback!=null) this.renewCallback(key, certBuffer);
    }

}