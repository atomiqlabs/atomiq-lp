import {Request, Response} from "express";
import {
    CompiledRateLimitWhitelist,
    getRateLimitWhitelistEntry, parseIpAddress
} from "./RateLimitWhitelist";

export function createHttpRateLimiter(
    maxRequests?: number,
    rateLimitWindow?: number,
    whitelist?: CompiledRateLimitWhitelist
): (req: Request, res: Response, next: () => void) => void {
    maxRequests ??= 100;
    rateLimitWindow ??= 5*60*1000;

    const ipStore: Map<string, {count: number, timestamp: number, windowMs: number, maxRequests: number}> = new Map();

    return (req: Request, res: Response, next: () => void) => {
        const parsedIp = parseIpAddress(req.ip);
        const ip = parsedIp.toNormalizedString();
        let storedState = ipStore.get(ip);
        if(storedState!=null) {
            if(Date.now() - storedState.timestamp > storedState.windowMs) {
                storedState.count = 1;
                storedState.timestamp = Date.now();
            } else {
                storedState.count++;
            }
        } else {
            const entry = getRateLimitWhitelistEntry(whitelist, parsedIp);
            const effectiveMaxRequests = entry?.REQUEST_LIMIT?.LIMIT ?? maxRequests;
            const effectiveWindowMs = entry?.REQUEST_LIMIT?.WINDOW_MS ?? rateLimitWindow;
            storedState = {
                count: 1,
                timestamp: Date.now(),
                windowMs: effectiveWindowMs,
                maxRequests: effectiveMaxRequests
            };
            ipStore.set(ip, storedState);
        }

        if (storedState.count > storedState.maxRequests) {
            return res.status(429).send('Too many requests');
        }

        next();
    };
}
