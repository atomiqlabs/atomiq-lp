import {Request, Response} from "express";

export function createHttpRateLimiter(maxRequests?: number, rateLimitWindow?: number): (req: Request, res: Response, next: () => void) => void {
    maxRequests ??= 100;
    rateLimitWindow ??= 5*60*1000;

    const ipStore: Map<string, {count: number, timestamp: number}> = new Map();

    return (req: Request, res: Response, next: () => void) => {
        const ip = req.ip;
        let storedState = ipStore.get(ip);
        if(storedState!=null) {
            if(Date.now() - storedState.timestamp > rateLimitWindow) {
                storedState.count = 1;
                storedState.timestamp = Date.now();
            } else {
                storedState.count++;
            }
        } else {
            storedState = {
                count: 1,
                timestamp: Date.now()
            };
            ipStore.set(ip, storedState);
        }

        if (storedState.count > maxRequests) {
            return res.status(429).send('Too many requests');
        }

        next();
    };
}
