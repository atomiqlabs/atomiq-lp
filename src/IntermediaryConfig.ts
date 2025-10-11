import {
    booleanParser, decimalToBigIntParser,
    dictionaryParserWithKeys,
    enumParser,
    numberParser,
    objectParser,
    parseConfig, percentageToPpmParser,
    stringParser,
    dictionaryParser, arrayParser, bigIntParser
} from "@atomiqlabs/server-base";
import * as fs from "fs";
import {parse} from "yaml";
import {RegisteredChains} from "./chains/ChainInitializer";

function getAllowedChains<T>(obj: T): (keyof T)[] {
    return Object.keys(obj) as (keyof T)[];
}

function getConfigs<T extends { [key: string]: { configuration: any } }>(chainData: T): { [K in keyof T]: T[K]['configuration'] } {
    const result = {} as { [K in keyof T]: T[K]['configuration'] };
    for (const key in chainData) {
        result[key] = chainData[key].configuration;
    }
    return result;
}

export const allowedChains = getAllowedChains(RegisteredChains);

const IntermediaryConfigTemplate = {
    ...getConfigs(RegisteredChains),

    BITCOIND: objectParser({
        PROTOCOL: enumParser(["http", "https"]),
        PORT: numberParser(false, 0, 65535),
        HOST: stringParser(),
        RPC_USERNAME: stringParser(),
        RPC_PASSWORD: stringParser(),
        NETWORK: enumParser<"mainnet" | "testnet" | "testnet4" | "regtest">(["mainnet", "testnet", "testnet4", "regtest"]),
        ADD_NETWORK_FEE: numberParser(true, 0, null, true),
        MULTIPLY_NETWORK_FEE: numberParser(true, 0, null, true),
        FEE_ESTIMATION_PERCENTILE: enumParser(["50", "90", "99", "99.9"], true)
    }),

    LND: objectParser({
        MNEMONIC_FILE: stringParser(null, null, true),
        WALLET_PASSWORD_FILE: stringParser(null, null, true),
        CERT: stringParser(null, null, true),
        MACAROON: stringParser(null, null, true),
        CERT_FILE: stringParser(null, null, true),
        MACAROON_FILE: stringParser(null, null, true),
        HOST: stringParser(),
        PORT: numberParser(false, 0, 65535),
    }, (data) => {
        if(data.CERT==null && data.CERT_FILE==null) throw new Error("Certificate for LND not provided, provide either CERT or CERT_FILE config!");
        if(data.MACAROON==null && data.MACAROON_FILE==null) throw new Error("Certificate for LND not provided, provide either MACAROON or MACAROON_FILE config!");
    }),

    LN: objectParser({
        BASE_FEE: decimalToBigIntParser(8, 0),
        FEE_PERCENTAGE: percentageToPpmParser(0),
        MIN: decimalToBigIntParser(8, 0),
        MAX: decimalToBigIntParser(8, 0),

        ALLOW_NON_PROBABLE_SWAPS: booleanParser(),
        ALLOW_LN_SHORT_EXPIRY: booleanParser(),

        INVOICE_EXPIRY_SECONDS: numberParser(false, 0, 3600, true),
        EXCLUDE_ASSETS: arrayParser(stringParser(), true),

        GAS_MAX: dictionaryParserWithKeys(
            numberParser(true, 0, undefined, true),
            allowedChains
        ),

        MAX_INFLIGHT_SWAPS: numberParser(false, 1, undefined, true),
        MAX_INFLIGHT_AUTO_SWAPS: numberParser(false, 1, undefined, true)
    }, null, true),

    ONCHAIN: objectParser({
        BASE_FEE: decimalToBigIntParser(8, 0),
        FEE_PERCENTAGE: percentageToPpmParser(0),
        MIN: decimalToBigIntParser(8, 0),
        MAX: decimalToBigIntParser(8, 0),

        MIN_TO_BTC: decimalToBigIntParser(8, 0, undefined, true),
        MAX_TO_BTC: decimalToBigIntParser(8, 0, undefined, true),

        MIN_FROM_BTC: decimalToBigIntParser(8, 0, undefined, true),
        MAX_FROM_BTC: decimalToBigIntParser(8, 0, undefined, true),

        NETWORK_FEE_ADD_PERCENTAGE: numberParser(true, 0, null),

        EXCLUDE_ASSETS: arrayParser(stringParser(), true),

        MAX_INFLIGHT_SWAPS: numberParser(false, 1, undefined, true)
    }, null, true),

    ONCHAIN_SPV: objectParser({
        MNEMONIC_FILE: stringParser(null, null, false),

        BASE_FEE: decimalToBigIntParser(8, 0),
        FEE_PERCENTAGE: percentageToPpmParser(0),
        MIN: decimalToBigIntParser(8, 0),
        MAX: decimalToBigIntParser(8, 0),
        GAS_MAX: dictionaryParserWithKeys(
            numberParser(true, 0, undefined, true),
            allowedChains
        ),

        EXCLUDE_ASSETS: arrayParser(stringParser(), true),

        MAX_INFLIGHT_SWAPS: numberParser(false, 1, undefined, true)
    }, null, true),

    LN_TRUSTED: objectParser({
        BASE_FEE: decimalToBigIntParser(8, 0),
        FEE_PERCENTAGE: percentageToPpmParser(0),
        MIN: decimalToBigIntParser(8, 0),
        MAX: decimalToBigIntParser(8, 0),

        INVOICE_EXPIRY_SECONDS: numberParser(false, 0, 3600, true),

        MAX_INFLIGHT_SWAPS: numberParser(false, 1, undefined, true)
    }, null, true),

    ONCHAIN_TRUSTED: objectParser({
        BASE_FEE: decimalToBigIntParser(8, 0),
        FEE_PERCENTAGE: percentageToPpmParser(0),
        MIN: decimalToBigIntParser(8, 0),
        MAX: decimalToBigIntParser(8, 0),

        SWAP_EXPIRY_SECONDS: numberParser(false, 0, 72*3600, true),

        MAX_INFLIGHT_SWAPS: numberParser(false, 1, undefined, true)
    }, null, true),

    PRICE_SOURCE: enumParser(["binance", "okx"], true),
    SECURITY_DEPOSIT_APY: percentageToPpmParser(0, undefined, true),

    ASSETS: dictionaryParser(
        objectParser({
            chains: dictionaryParserWithKeys(
                objectParser({
                    address: stringParser(),
                    decimals: numberParser(false, 0),
                    securityDepositAllowed: booleanParser(true),
                    spvVaultMultiplier: bigIntParser(1n, undefined, true)
                }, null, true),
                allowedChains
            ),
            pricing: stringParser(),
            disabled: booleanParser(true)
        })
    ),

    CLI: objectParser({
        ADDRESS: stringParser(),
        PORT: numberParser(false, 0, 65535)
    }),

    REST: objectParser({
        ADDRESS: stringParser(),
        PORT: numberParser(false, 0, 65535),

        REQUEST_LIMIT: objectParser({
            LIMIT: numberParser(false, 0),
            WINDOW_MS: numberParser(false, 0)
        }, undefined, true),

        CONNECTION_LIMIT: numberParser(false, 0, undefined, true),
        CONNECTION_TIMEOUT_MS: numberParser(false, 0, undefined, true)
    }),

    RPC: objectParser({
        ADDRESS: stringParser(),
        PORT: numberParser(false, 0, 65535)
    }, null, true),

    SSL: objectParser({
        CERT_FILE: stringParser(),
        KEY_FILE: stringParser()
    }, null, true),

    SSL_AUTO: objectParser({
        ACME_METHOD: enumParser<"http-01" | "tls-alpn-01">(["http-01", "tls-alpn-01"], true),

        IP_ADDRESS_FILE: stringParser(null, null, true),

        HTTP_LISTEN_ADDRESS: stringParser(null, null, true),
        HTTP_LISTEN_PORT: numberParser(false, 0, 65535, true),

        DNS_PROXY: stringParser(null, null, true),
        FULL_DNS_DOMAIN: stringParser(null, null, true)
    }, (obj) => {
        if(obj.DNS_PROXY==null && obj.FULL_DNS_DOMAIN==null) throw new Error("Either DNS_PROXY or FULL_DNS_DOMAIN needs to be specified!");
        if((obj.ACME_METHOD==null || obj.ACME_METHOD==="http-01") && obj.HTTP_LISTEN_PORT==null) throw new Error("HTTP_LISTEN_PORT needs to be configured when using `http-01` ACME method!");
    }, true),

    PLUGINS: dictionaryParser(
        stringParser(),
        null,
        true
    )
};

export let IntermediaryConfig = parseConfig(parse(fs.readFileSync(process.env.CONFIG_FILE).toString()), IntermediaryConfigTemplate);
