import {Request, Response} from "express";
import {getLogger} from "@atomiqlabs/lp-lib/dist/utils/Utils";
import {
    CompiledRateLimitWhitelist,
    getRateLimitWhitelistEntry, parseIpAddress
} from "./RateLimitWhitelist";

const logger = getLogger("ConcurrentRequestsLimitter: ");

export function createConnectionRateLimiter(
    maxConnections?: number,
    whitelist?: CompiledRateLimitWhitelist
): (req: Request, res: Response, next: () => void) => void {
    maxConnections ??= 5;

    const ipStore: Map<string, {count: number, limit: number}> = new Map();

    return (req: Request, res: Response, next: () => void) => {
        const parsedIp = parseIpAddress(req.ip);
        const ip = parsedIp.toNormalizedString();
        let connectionCount = ipStore.get(ip);

        if(connectionCount==null) {
            const entry = getRateLimitWhitelistEntry(whitelist, parsedIp);
            const effectiveMaxConnections = entry?.CONNECTION_LIMIT ?? maxConnections;
            connectionCount = {
                count: 0,
                limit: effectiveMaxConnections
            }
            if(connectionCount.limit>0) ipStore.set(ip, connectionCount);
        }

        if (connectionCount.count >= connectionCount.limit) {
            res.status(503).send('Too many open requests');
            return;
        }

        connectionCount.count++;
        if(req.path!=="/") logger.debug("OPEN "+ip+" -> "+req.path+", concurrent connections: "+connectionCount.count);

        let cleanedUp = false;
        const cleanup = () => {
            if(cleanedUp) return;
            cleanedUp = true;
            connectionCount.count--;
            if(req.path!=="/") logger.debug("CLOSE "+ip+" -> "+req.path+", concurrent connections: "+connectionCount.count);
            if(connectionCount.count===0) {
                ipStore.delete(ip);
            }
        };

        res.on('finish', cleanup);
        res.on('error', cleanup);
        res.on('close', cleanup);

        next();
    };
}
