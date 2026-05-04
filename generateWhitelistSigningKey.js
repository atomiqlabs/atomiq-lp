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
    if(!/^[0-9a-fA-F]{66}$/.test(value)) throw new Error(`${name} must be a compressed 33-byte hex public key`);
    const bytes = Buffer.from(value, "hex");
    if(!secp256k1.utils.isValidPublicKey(bytes, true)) throw new Error(`${name} is not a valid compressed secp256k1 public key`);
    return bytes;
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
        requestPublicKey = secp256k1.getPublicKey(requestPrivateKey, true);
        console.log("Request signing private key: "+toHex(requestPrivateKey));
    }

    if(process.argv[2]==null) console.log("Authority private key: "+toHex(authorityPrivateKey));

    const authorityPublicKey = secp256k1.getPublicKey(authorityPrivateKey, true);
    const authoritySignature = schnorr.sign(requestPublicKey, authorityPrivateKey);

    console.log("Authority public key: "+toHex(authorityPublicKey));
    console.log("Authority signature: "+toHex(authoritySignature));
    console.log("Request signing public key: "+toHex(requestPublicKey));
} catch (e) {
    console.error(e instanceof Error ? e.message : e);
    console.error("Usage: node generateWhitelistSigningKey.js [authorityPrivateKeyHex] [requestSigningPublicKeyHex]");
    process.exit(1);
}
