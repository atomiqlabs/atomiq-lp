import {Client, directory, crypto} from "acme-client";
import * as fs from "fs/promises";
import {createServer, Server} from "node:http";
import {X509Certificate} from "node:crypto";

export class LetsEncryptACME {

    readonly hostnames: string[];
    readonly keyFile: string;
    readonly certFile: string;
    readonly listenPort: number;
    readonly renewBuffer: number;

    renewCallback: (key: Buffer, cert: Buffer) => void;
    client: Client;

    constructor(hostnames: string[], keyFile: string, certFile: string, listenPort: number = 80, renewBuffer: number = 14*24*60*60*1000) {
        this.hostnames = hostnames;
        this.keyFile = keyFile;
        this.certFile = certFile;
        this.listenPort = listenPort;
        this.renewBuffer = renewBuffer;
    }

    async init(renewCallback: (key: Buffer, cert: Buffer) => void) {
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

        let httpServer: Server;
        let httpServerCreatePromise: Promise<void>;
        const challenges: {[challengeToken: string]: string} = {};

        if(existingKey==null) console.log("[ACME]: Requesting certificate!");

        const cert = await this.client.auto({
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
                    httpServer.listen(this.listenPort, resolve);
                });
            },
            challengeRemoveFn: (authz, challenge) => {
                delete challenges[challenge.token];
                if(Object.keys(challenges).length!==0) return Promise.resolve();
                return new Promise<void>((resolve, reject) => httpServer.close(err => err==null ? resolve() : reject(err)));
            }
        });

        console.log("[ACME]: Certificate request success!");

        const certBuffer = Buffer.from(cert);
        await fs.writeFile(this.keyFile, key);
        await fs.writeFile(this.certFile, certBuffer);

        console.log("[ACME]: Key & certificate written to the disk!");

        if(this.renewCallback!=null) this.renewCallback(key, certBuffer);
    }

}