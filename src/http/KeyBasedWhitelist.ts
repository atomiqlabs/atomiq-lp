/**
 * Expects a `x-atomiq-auth` header with the following binary format, that is hex-encoded:
 * - 4 bytes - timestamp (timestamp when the request was sent)
 * - 32 bytes - random bytes (entropy, to be signed)
 *
 * - 32 bytes - key of the signing authority
 * - 64 bytes - schnorr signature signing the request signing key by the signing authority
 *
 * - 32 bytes - request signing key (signed by the signing authority)
 * - 64 bytes - schnorr signature of the timestamp and random bytes
 *
 * Uses secp256k1 curve and schnorr signatures
 */

import {Request, RequestHandler} from "express";
import {schnorr} from "@noble/curves/secp256k1";

type RateLimitOverride = {
    REQUEST_LIMIT?: {
        LIMIT: number,
        WINDOW_MS: number,
    },
    CONNECTION_LIMIT?: number,
};

type RateLimitOverrides = {
    [signingAuthorityKey: string]: RateLimitOverride
};

declare global {
    namespace Express {
        interface Request {
            metadata?: RateLimitOverride;
        }
    }
}

export class KeyBasedWhitelist {

    // Maps the known signing authorities to the defined request and connection limits
    rateLimitOverrides: RateLimitOverrides;

    // Stores the already used random bytes with their timestamp, values that have timestamps which are already expired
    //  should be periodically purged
    usedRandomBytes: Map<string, number>;

    // Time in milliseconds after which a request timestamp is considered expired
    requestExpiryTime: number;

    cleanupInterval?: ReturnType<typeof setInterval>;

    // Constructor accepting the rateLimitOverrides, plus an optional expiry time in milliseconds param
    constructor(rateLimitOverrides: RateLimitOverrides, requestExpiryTime = 60*1000) {
        this.rateLimitOverrides = {};
        for(const key in rateLimitOverrides) {
            this.rateLimitOverrides[key.toLowerCase()] = rateLimitOverrides[key];
        }
        this.usedRandomBytes = new Map();
        this.requestExpiryTime = requestExpiryTime;
    }

    // Returns the adjusted limits for a valid authorization, or undefined when no header is present.
    // Valid authorizations are added to usedRandomBytes so they cannot be replayed.
    getRateLimitOverride(req: Request): RateLimitOverride | undefined {
        const header = req.header("x-atomiq-auth");
        if(header==null) return undefined;
        if(header.length!==456 || !/^[0-9a-fA-F]+$/.test(header)) throw new Error("Invalid x-atomiq-auth header format");

        const authorization = Buffer.from(header, "hex");
        if(authorization.length!==228) throw new Error("Invalid x-atomiq-auth header length");

        const timestamp = authorization.readUInt32BE(0) * 1000;
        if(Math.abs(Date.now() - timestamp)>this.requestExpiryTime) throw new Error("Expired x-atomiq-auth header");

        const randomBytes = authorization.subarray(4, 36);
        const randomBytesHex = randomBytes.toString("hex");
        if(this.usedRandomBytes.has(randomBytesHex)) throw new Error("Replayed x-atomiq-auth header");

        const signingAuthorityKey = authorization.subarray(36, 68);
        const signingAuthorityKeyHex = signingAuthorityKey.toString("hex");
        const rateLimitOverride = this.rateLimitOverrides[signingAuthorityKeyHex];
        if(rateLimitOverride==null) throw new Error("Unknown x-atomiq-auth signing authority");

        const authoritySignature = authorization.subarray(68, 132);
        const requestSigningKey = authorization.subarray(132, 164);
        const requestSignature = authorization.subarray(164, 228);

        if(!schnorr.verify(authoritySignature, requestSigningKey, signingAuthorityKey)) throw new Error("Invalid x-atomiq-auth authority signature");
        if(!schnorr.verify(requestSignature, authorization.subarray(0, 36), requestSigningKey)) throw new Error("Invalid x-atomiq-auth request signature");

        this.usedRandomBytes.set(randomBytesHex, timestamp);
        return rateLimitOverride;
    }

    getMiddleware(): RequestHandler {
        return (req, res, next) => {
            try {
                const rateLimitOverride = this.getRateLimitOverride(req);
                if(rateLimitOverride!=null) {
                    req.metadata ??= {};
                    req.metadata.REQUEST_LIMIT = rateLimitOverride.REQUEST_LIMIT;
                    req.metadata.CONNECTION_LIMIT = rateLimitOverride.CONNECTION_LIMIT;
                }
                next();
            } catch (e) {
                res.status(400).send(e instanceof Error ? e.message : "Invalid x-atomiq-auth header");
            }
        };
    }

    // Starts/stops the interval for cleaning up the usedRandomBytes mapping.
    start(): void {
        if(this.cleanupInterval!=null) return;
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            for(const [randomBytes, timestamp] of this.usedRandomBytes) {
                if(now - timestamp > this.requestExpiryTime) this.usedRandomBytes.delete(randomBytes);
            }
        }, this.requestExpiryTime);
        this.cleanupInterval.unref();
    }

    stop(): void {
        if(this.cleanupInterval==null) return;
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = undefined;
    }

}
