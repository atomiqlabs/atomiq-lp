import {Request, Response} from "express";

export function createBodySizeLimiter(maxRequestSize?: number): (req: Request, res: Response, next: () => void) => void {
    maxRequestSize ??= 8*1024;

    return (req: Request, res: Response, next: () => void) => {
        let receivedBytes = 0;

        req.on('data', chunk => {
            receivedBytes += chunk.length;

            if (receivedBytes > maxRequestSize) {
                req.destroy(); // Abort connection
            }
        });

        next();
    };
}
