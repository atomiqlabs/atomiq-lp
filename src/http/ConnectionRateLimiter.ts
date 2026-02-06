import {Request, Response} from "express";
import {getLogger} from "@atomiqlabs/lp-lib/dist/utils/Utils";

const logger = getLogger("ConcurrentRequestsLimitter: ");

export function createConnectionRateLimiter(maxConnections?: number): (req: Request, res: Response, next: () => void) => void {
    maxConnections ??= 5;

    const ipStore: Map<string, number> = new Map();

    return (req: Request, res: Response, next: () => void) => {
        const ip = req.ip;
        let connectionCount = ipStore.get(ip) ?? 0;

        if (connectionCount >= maxConnections) {
            res.status(503).send('Too many open requests');
            return;
        }

        ipStore.set(ip,  connectionCount+1);
        if(req.path!=="/") logger.debug("OPEN "+ip+" -> "+req.path+", concurrent connections: "+(connectionCount+1));

        let cleanedUp = false;
        const cleanup = () => {
            if(cleanedUp) return;
            cleanedUp = true;
            let connectionCount = (ipStore.get(ip) ?? 1) - 1;
            if(req.path!=="/") logger.debug("CLOSE "+ip+" -> "+req.path+", concurrent connections: "+connectionCount);
            if(connectionCount===0) {
                ipStore.delete(ip);
            } else {
                ipStore.set(ip, connectionCount);
            }
        };

        res.on('finish', cleanup);
        res.on('error', cleanup);
        res.on('close', cleanup);

        next();
    };
}
