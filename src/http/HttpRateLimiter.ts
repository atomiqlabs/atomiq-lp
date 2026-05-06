import {Request, RequestHandler, Response} from "express";

export class HttpRateLimiter {

    maxRequests: number;
    rateLimitWindow: number;

    ipStore: Map<string, {remainingCount: number, expiry: number}> = new Map();
    overrideStore: Map<string, {remainingCount: number, expiry: number}> = new Map();

    cleanupInterval?: ReturnType<typeof setInterval>;

    constructor(maxRequests?: number, rateLimitWindow?: number) {
        this.maxRequests = maxRequests ?? 300;
        this.rateLimitWindow = rateLimitWindow ?? 5*60*1000;
    }

    getPreMiddleware(): RequestHandler {
        return (req: Request, res: Response, next: () => void) => {
            const ip = req.ip;
            let storedState = this.ipStore.get(ip);

            if (storedState!=null && storedState.remainingCount <= 0 && storedState.expiry > Date.now()) {
                return res.status(429).send('Too many requests');
            }

            if(req.rateLimitOverride?.identifier!=null && req.rateLimitOverride?.limits?.REQUEST_LIMIT!=null) {
                let storedState = this.overrideStore.get(req.rateLimitOverride.identifier);

                if (storedState!=null && storedState.remainingCount <= 0 && storedState.expiry > Date.now()) {
                    return res.status(429).send('Too many requests');
                }
            }

            next();
        };
    }

    getPostMiddleware(): RequestHandler {
        return (req: Request, res: Response, next: () => void) => {
            const hasRateLimitOverride = req.rateLimitOverride?.identifier!=null && req.rateLimitOverride?.limits?.REQUEST_LIMIT!=null;

            let rateLimitOverrideError: Error;
            if(hasRateLimitOverride) try {
                req.rateLimitOverride.verify();
            } catch (e) {
                rateLimitOverrideError = e;
            }

            if(!hasRateLimitOverride || rateLimitOverrideError!=null) {
                const ip = req.ip;

                let storedState = this.ipStore.get(ip);
                if(storedState!=null && Date.now() < storedState.expiry) {
                    storedState.remainingCount--;
                } else {
                    storedState = {
                        remainingCount: this.maxRequests - 1,
                        expiry: Date.now() + this.rateLimitWindow
                    };
                    this.ipStore.set(ip, storedState);
                }

                if(rateLimitOverrideError!=null)
                    return res.status(400).send(
                        rateLimitOverrideError instanceof Error
                            ? rateLimitOverrideError.message
                            : "Failed to process request"
                    );

                return next();
            }

            const rateLimitOverrides = req.rateLimitOverride.limits.REQUEST_LIMIT;

            let storedState = this.overrideStore.get(req.rateLimitOverride.identifier);
            if(storedState!=null && Date.now() < storedState.expiry) {
                storedState.remainingCount--;
            } else {
                storedState = {
                    remainingCount: rateLimitOverrides.LIMIT - 1,
                    expiry: Date.now() + rateLimitOverrides.WINDOW_MS
                };
                this.overrideStore.set(req.rateLimitOverride.identifier, storedState);
            }

            next();
        };
    }

    start(): void {
        if(this.cleanupInterval!=null) return;
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            for(const [ip, status] of this.ipStore) {
                if(status.expiry < now) this.ipStore.delete(ip);
            }
            for(const [identifier, status] of this.overrideStore) {
                if(status.expiry < now) this.overrideStore.delete(identifier);
            }
        }, 60*1000);
        this.cleanupInterval.unref();
    }

    stop(): void {
        if(this.cleanupInterval==null) return;
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = undefined;
    }

}
