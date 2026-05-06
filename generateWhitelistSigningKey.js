#!/usr/bin/env node

const {secp256k1, schnorr} = require("@noble/curves/secp256k1");

function toHex(bytes) {
    return Buffer.from(bytes).toString("hex");
}

function parsePrivateKey(value, name) {
    if(!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be a 32-byte hex private key`);
    const bytes = Buffer.from(value, "hex");
    if(!secp256k1.utils.isValidPrivateKey(bytes)) throw new Error(`${name} is not a valid secp256k1 private key`);
    return bytes;
}

function parsePublicKey(value, name) {
    if(!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be an X-only 32-byte hex public key`);
    if(!secp256k1.utils.isValidPublicKey(Buffer.from("02"+value, "hex"), true)) throw new Error(`${name} is not a valid X-only 32-byte secp256k1 public key`);
    return Buffer.from(value, "hex");
}

try {
    const authorityPrivateKey = process.argv[2]!=null ?
        parsePrivateKey(process.argv[2], "Authority private key") :
        secp256k1.utils.randomPrivateKey();

    let requestPublicKey;
    if(process.argv[3]!=null) {
        requestPublicKey = parsePublicKey(process.argv[3], "Request signing public key");
    } else {
        const requestPrivateKey = secp256k1.utils.randomPrivateKey();
        requestPublicKey = schnorr.getPublicKey(requestPrivateKey, true);
        console.log("Request signing private key: "+toHex(requestPrivateKey));
    }

    if(process.argv[2]==null) console.log("Authority private key: "+toHex(authorityPrivateKey));

    const authorityPublicKey = schnorr.getPublicKey(authorityPrivateKey, true);
    const authoritySignature = schnorr.sign(requestPublicKey, authorityPrivateKey);

    console.log("Authority public key: "+toHex(authorityPublicKey));
    console.log("Authority signature: "+toHex(authoritySignature));
    console.log("Request signing public key: "+toHex(requestPublicKey));

    console.log("Certificate: "+toHex(authorityPublicKey)+toHex(authoritySignature)+toHex(requestPublicKey));
} catch (e) {
    console.error(e instanceof Error ? e.message : e);
    console.error("Usage: node generateWhitelistSigningKey.js [authorityPrivateKeyHex] [requestSigningPublicKeyHex]");
    process.exit(1);
}
