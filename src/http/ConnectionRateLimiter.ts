import {Request, Response} from "express";

export function createConnectionRateLimiter(maxConnections?: number): (req: Request, res: Response, next: () => void) => void {
    maxConnections ??= 5;

    const ipStore: Map<string, number> = new Map();

    return (req: Request, res: Response, next: () => void) => {
        const ip = req.ip;
        let connectionCount = (ipStore.get(ip) ?? 0) + 1;
        ipStore.set(ip,  connectionCount);

        if (connectionCount > maxConnections) {
            res.status(503).send('Too many open connections');
            return;
        }

        res.on('finish', () => {
            let connectionCount = (ipStore.get(ip) ?? 1) - 1;
            if(connectionCount===0) {
                ipStore.delete(ip);
            } else {
                ipStore.set(ip, connectionCount);
            }
        });

        next();
    };
}
