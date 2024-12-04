import {
    booleanParser, decimalToBNParser,
    dictionaryParserWithKeys,
    enumParser,
    numberParser,
    objectParser,
    parseConfig, percentageToPpmParser,
    stringParser,
    dictionaryParser
} from "crosslightning-server-base";
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

const allowedChains = getAllowedChains(RegisteredChains);

const IntermediaryConfigTemplate = {
    ...getConfigs(RegisteredChains),

    BITCOIND: objectParser({
        PROTOCOL: enumParser(["http", "https"]),
        PORT: numberParser(false, 0, 65535),
        HOST: stringParser(),
        RPC_USERNAME: stringParser(),
        RPC_PASSWORD: stringParser(),
        NETWORK: enumParser(["mainnet", "testnet"]),
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
        BASE_FEE: decimalToBNParser(8, 0),
        FEE_PERCENTAGE: percentageToPpmParser(0),
        MIN: decimalToBNParser(8, 0),
        MAX: decimalToBNParser(8, 0),

        ALLOW_NON_PROBABLE_SWAPS: booleanParser(),
        ALLOW_LN_SHORT_EXPIRY: booleanParser(),

        INVOICE_EXPIRY_SECONDS: numberParser(false, 0, 3600, true)
    }, null, true),

    ONCHAIN: objectParser({
        BASE_FEE: decimalToBNParser(8, 0),
        FEE_PERCENTAGE: percentageToPpmParser(0),
        MIN: decimalToBNParser(8, 0),
        MAX: decimalToBNParser(8, 0),

        NETWORK_FEE_ADD_PERCENTAGE: percentageToPpmParser(0),

        ADD_NETWORK_FEE: numberParser(true, 0, null, true),
        MULTIPLY_NETWORK_FEE: numberParser(true, 0, null, true),
    }, null, true),

    LN_TRUSTED: objectParser({
        BASE_FEE: decimalToBNParser(8, 0),
        FEE_PERCENTAGE: percentageToPpmParser(0),
        MIN: decimalToBNParser(8, 0),
        MAX: decimalToBNParser(8, 0),

        INVOICE_EXPIRY_SECONDS: numberParser(false, 0, 3600, true)
    }, null, true),

    ONCHAIN_TRUSTED: objectParser({
        BASE_FEE: decimalToBNParser(8, 0),
        FEE_PERCENTAGE: percentageToPpmParser(0),
        MIN: decimalToBNParser(8, 0),
        MAX: decimalToBNParser(8, 0),

        SWAP_EXPIRY_SECONDS: numberParser(false, 0, 72*3600, true)
    }, null, true),

    ASSETS: dictionaryParser(
        objectParser({
            chains: dictionaryParserWithKeys(
                objectParser({
                    address: stringParser(),
                    decimals: numberParser(false, 0)
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
        PORT: numberParser(false, 0, 65535)
    }),

    SSL: objectParser({
        CERT_FILE: stringParser(),
        KEY_FILE: stringParser()
    }, null, true),

    SSL_AUTO: objectParser({
        IP_ADDRESS_FILE: stringParser(null, null, true),
        HTTP_LISTEN_PORT: numberParser(false, 0, 65535),
        DNS_PROXY: stringParser()
    }, null, true),

    PLUGINS: dictionaryParser(
        stringParser(),
        null,
        true
    )
};

export let IntermediaryConfig = parseConfig(parse(fs.readFileSync(process.env.CONFIG_FILE).toString()), IntermediaryConfigTemplate);
