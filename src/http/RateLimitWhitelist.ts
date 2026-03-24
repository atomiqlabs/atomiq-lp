import * as ipaddr from "ipaddr.js";

export type RequestLimitWhitelistEntry = {
    LIMIT: number,
    WINDOW_MS?: number
};

export type RateLimitWhitelistEntry = {
    REQUEST_LIMIT?: RequestLimitWhitelistEntry,
    CONNECTION_LIMIT?: number
};

export type RateLimitWhitelist = {
    [key: string]: RateLimitWhitelistEntry
};

type ParsedIpAddress = ipaddr.IPv4 | ipaddr.IPv6;

type CompiledRangeEntry = {
    range: [ParsedIpAddress, number],
    value: RateLimitWhitelistEntry,
    index: number
};

export type CompiledRateLimitWhitelist = {
    exactEntries: Map<string, RateLimitWhitelistEntry>,
    rangeEntries: CompiledRangeEntry[]
};

export function parseIpAddress(ip: string): ParsedIpAddress {
    return ipaddr.process(ip);
}

function parseRangeKey(key: string): [ParsedIpAddress, number] {
    const separatorIndex = key.lastIndexOf("/");
    if(separatorIndex===-1) throw new Error("Invalid IP/CIDR entry");

    const address = key.substring(0, separatorIndex).trim();
    const prefixString = key.substring(separatorIndex+1).trim();
    const prefix = Number(prefixString);
    const parsedAddress = parseIpAddress(address);
    const maxPrefix = parsedAddress.kind()==="ipv4" ? 32 : 128;

    if(!Number.isInteger(prefix) || prefix<0 || prefix>maxPrefix) {
        throw new Error("Invalid CIDR prefix length");
    }

    return [parsedAddress, prefix];
}

export function validateRateLimitWhitelist(whitelist?: RateLimitWhitelist): void {
    compileRateLimitWhitelist(whitelist);
}

export function compileRateLimitWhitelist(whitelist?: RateLimitWhitelist): CompiledRateLimitWhitelist | null {
    if(whitelist==null) return null;

    const exactEntries: Map<string, RateLimitWhitelistEntry> = new Map();
    const rangeEntries: CompiledRangeEntry[] = [];

    let index = 0;
    for(let key in whitelist) {
        try {
            if(key.includes("/")) {
                rangeEntries.push({
                    range: parseRangeKey(key),
                    value: whitelist[key],
                    index
                });
            } else {
                const normalizedIp = parseIpAddress(key.trim()).toNormalizedString();
                exactEntries.set(normalizedIp, whitelist[key]);
            }
        } catch (e) {
            throw new Error("Invalid whitelist entry '"+key+"': "+e.message);
        }
        index++;
    }

    rangeEntries.sort((a, b) => {
        const prefixDifference = b.range[1] - a.range[1];
        if(prefixDifference!==0) return prefixDifference;
        return a.index - b.index;
    });

    return {
        exactEntries,
        rangeEntries
    };
}

export function getRateLimitWhitelistEntry(compiledWhitelist: CompiledRateLimitWhitelist, parsedIp: ParsedIpAddress): RateLimitWhitelistEntry | undefined {
    const normalizedIp = parsedIp.toNormalizedString();

    const exactMatch = compiledWhitelist?.exactEntries.get(normalizedIp);
    if(exactMatch!=null) {
        return exactMatch;
    }

    for(let rangeEntry of compiledWhitelist?.rangeEntries ?? []) {
        if(parsedIp.kind()==="ipv4" && rangeEntry.range[0].kind()==="ipv4") {
            const parsedIpv4 = parsedIp as ipaddr.IPv4;
            if(parsedIpv4.match(rangeEntry.range as [ipaddr.IPv4, number])) {
                return rangeEntry.value;
            }
        }
        if(parsedIp.kind()==="ipv6" && rangeEntry.range[0].kind()==="ipv6") {
            const parsedIpv6 = parsedIp as ipaddr.IPv6;
            if(parsedIpv6.match(rangeEntry.range as [ipaddr.IPv6, number])) {
                return rangeEntry.value;
            }
        }
    }
}
