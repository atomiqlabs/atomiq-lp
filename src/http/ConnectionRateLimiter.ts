import {Request, RequestHandler, Response} from "express";
import {getLogger} from "@atomiqlabs/lp-lib/dist/utils/Utils";

const logger = getLogger("ConcurrentRequestsLimitter: ");

export class ConnectionRateLimiter {

    maxConnections: number;

    ipStore: Map<string, number> = new Map();
    overrideStore: Map<string, number> = new Map();

    constructor(maxConnections?: number) {
        this.maxConnections = maxConnections ?? 5;
    }

    getPreMiddleware(): RequestHandler {
        return (req: Request, res: Response, next: () => void) => {
            const ip = req.ip;
            let connectionCount = this.ipStore.get(ip) ?? 0;

            if (connectionCount >= this.maxConnections) {
                res.status(503).send('Too many open requests');
                return;
            }

            if(req.rateLimitOverride?.identifier!=null && req.rateLimitOverride?.limits?.CONNECTION_LIMIT!=null) {
                connectionCount = this.overrideStore.get(req.rateLimitOverride.identifier) ?? 0;

                if (connectionCount >= req.rateLimitOverride.limits.CONNECTION_LIMIT) {
                    res.status(503).send('Too many open requests');
                    return;
                }
            }

            next();
        };
    }

    getPostMiddleware(): RequestHandler {
        return (req: Request, res: Response, next: () => void) => {
            const hasRateLimitOverride = req.rateLimitOverride?.identifier!=null && req.rateLimitOverride?.limits?.CONNECTION_LIMIT!=null;

            let rateLimitOverrideError: Error;
            if(hasRateLimitOverride) try {
                req.rateLimitOverride.verify();
            } catch (e) {
                rateLimitOverrideError = e;
            }

            if(!hasRateLimitOverride || rateLimitOverrideError!=null) {
                this.registerConnection(req, res, this.ipStore, req.ip);

                if(rateLimitOverrideError!=null)
                    return res.status(400).send(
                        rateLimitOverrideError instanceof Error
                            ? rateLimitOverrideError.message
                            : "Failed to process request"
                    );

                return next();
            }

            this.registerConnection(req, res, this.overrideStore, req.rateLimitOverride.identifier);
            next();
        };
    }

    registerConnection(req: Request, res: Response, store: Map<string, number>, key: string): void {
        const ip = req.ip;
        let connectionCount = store.get(key) ?? 0;

        store.set(key,  connectionCount+1);
        if(req.path!=="/") logger.debug("OPEN "+ip+" -> "+req.path+", concurrent connections: "+(connectionCount+1));

        let cleanedUp = false;
        const cleanup = () => {
            if(cleanedUp) return;
            cleanedUp = true;
            let connectionCount = (store.get(key) ?? 1) - 1;
            if(req.path!=="/") logger.debug("CLOSE "+ip+" -> "+req.path+", concurrent connections: "+connectionCount);
            if(connectionCount===0) {
                store.delete(key);
            } else {
                store.set(key, connectionCount);
            }
        };

        res.on('finish', cleanup);
        res.on('error', cleanup);
        res.on('close', cleanup);

    }

}
