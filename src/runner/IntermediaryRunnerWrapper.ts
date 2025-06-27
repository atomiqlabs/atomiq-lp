import {BitcoinRpc, ChainSwapType} from "@atomiqlabs/base";
import {
    FromBtcLnSwapAbs,
    FromBtcLnSwapState,
    FromBtcSwapAbs,
    FromBtcSwapState, IBitcoinWallet, ILightningWallet, ISpvVaultSigner,
    ISwapPrice, MultichainData,
    PluginManager, SpvVault, SpvVaultState,
    SwapHandlerType,
    ToBtcLnSwapAbs,
    ToBtcLnSwapState,
    ToBtcSwapAbs,
    ToBtcSwapState
} from "@atomiqlabs/lp-lib";
import {IntermediaryRunner} from "./IntermediaryRunner";
import {
    cmdEnumParser,
    cmdNumberParser,
    cmdStringParser,
    CommandHandler,
    createCommand
} from "@atomiqlabs/server-base";
import {fromDecimal, toDecimal} from "../Utils";
import {allowedChains, IntermediaryConfig} from "../IntermediaryConfig";
import {Registry} from "../Registry";
import * as bolt11 from "@atomiqlabs/bolt11";
import {bigIntSorter} from "@atomiqlabs/lp-lib/dist/utils/Utils";

function sortVaults(vaults: SpvVault[]) {
    vaults.sort(
        (a, b) => bigIntSorter(a.data.getVaultId(), b.data.getVaultId())
    );
}

export class IntermediaryRunnerWrapper extends IntermediaryRunner {

    cmdHandler: CommandHandler;
    lpRegistry: Registry;
    addressesToTokens: {
        [chainId: string]: {
            [address: string]: {
                ticker: string,
                decimals: number
            }
        }
    };

    fromReadableToken(txt: string) {
        const arr = txt.split("-");
        if(arr.length>1) {
            return {ticker: txt.substring(arr[0].length+1), chainId: arr[0]}
        } else {
            return {ticker: txt, chainId: this.multichainData.default};
        }
    }

    toReadableToken(chainId: string, ticker: string) {
        return chainId+"-"+ticker;
    }

    constructor(
        directory: string,
        multichainData: MultichainData,
        tokens: {
            [ticker: string]: {
                chains: {
                    [chainIdentifier: string] : {
                        address: string,
                        decimals: number
                    }
                },
                pricing: string,
                disabled?: boolean
            }
        },
        prices: ISwapPrice<any>,
        bitcoinRpc: BitcoinRpc<any>,
        bitcoinWallet: IBitcoinWallet,
        lightningWallet: ILightningWallet,
        spvVaultSigner: ISpvVaultSigner
    ) {
        super(directory, multichainData, tokens, prices, bitcoinRpc, bitcoinWallet, lightningWallet, spvVaultSigner);
        this.lpRegistry = new Registry(directory+"/lpRegistration.txt");
        this.addressesToTokens = {};
        const tokenTickers = [];
        for(let ticker in this.tokens) {
            for(let chainId in this.tokens[ticker].chains) {
                if(this.addressesToTokens[chainId]==null) this.addressesToTokens[chainId] = {};
                const tokenData = this.tokens[ticker].chains[chainId];
                this.addressesToTokens[chainId][tokenData.address] = {
                    decimals: tokenData.decimals,
                    ticker
                };
                tokenTickers.push(this.toReadableToken(chainId, ticker));
            }
        }
        const commands = [
            createCommand(
                "status",
                "Fetches the current status of the bitcoin RPC, LND gRPC & intermediary application",
                {
                    args: {},
                    parser: async (args) => {
                        const reply: string[] = [];

                        reply.push("SmartChains status:");
                        for(let chainId in this.multichainData.chains) {
                            const {chainInterface, signer} = this.multichainData.chains[chainId];
                            const nativeTokenAddress = chainInterface.getNativeCurrencyAddress();
                            const {decimals, ticker} = this.addressesToTokens[chainId][nativeTokenAddress.toString()];
                            let nativeTokenBalance: bigint;
                            try {
                                nativeTokenBalance = await chainInterface.getBalance(signer.getAddress(), nativeTokenAddress);
                            } catch (e) {
                                console.error(e);
                            }
                            reply.push("    "+chainId+":");
                            reply.push("        RPC status: "+(nativeTokenBalance!=null ? "ready" : "offline!"));
                            if(nativeTokenBalance!=null) {
                                reply.push("        Funds: " + toDecimal(nativeTokenBalance, decimals)+" "+ticker);
                                reply.push("        Has enough funds (>0.1): " + (nativeTokenBalance > 100000000n ? "yes" : "no"));
                            }
                        }

                        if(this.bitcoinRpc!=null) {
                            const btcRpcStatus = await this.bitcoinRpc.getSyncInfo().catch(e => null);
                            reply.push("Bitcoin RPC status:");
                            reply.push("    Status: "+(btcRpcStatus==null ? "offline" : btcRpcStatus.ibd ? "verifying blockchain" : "ready"));
                            if(btcRpcStatus!=null) {
                                reply.push("    Verification progress: "+(btcRpcStatus.verificationProgress*100).toFixed(4)+"%");
                                reply.push("    Synced headers: "+btcRpcStatus.headers);
                                reply.push("    Synced blocks: "+btcRpcStatus.blocks);
                            }
                        }

                        if(this.bitcoinWallet!=null) {
                            reply.push("Bitcoin wallet status:");
                            reply.push("    Wallet status: "+this.bitcoinWallet.getStatus());
                            const bitcoinInfo = this.bitcoinWallet.getStatusInfo();
                            for(let key in bitcoinInfo) {
                                reply.push("    "+key+": "+bitcoinInfo[key]);
                            }
                        }

                        if(this.lightningWallet!=null) {
                            reply.push("Lightning wallet status:");
                            reply.push("    Wallet status: " + this.lightningWallet.getStatus());
                            if (this.lightningWallet.isReady()) reply.push("    Node pubkey: " + await this.lightningWallet.getIdentityPublicKey());
                            const lightningInfo = this.lightningWallet.getStatusInfo();
                            for (let key in lightningInfo) {
                                reply.push("    " + key + ": " + lightningInfo[key]);
                            }
                        }

                        reply.push("LP node status: "+this.initState);

                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "getaddress",
                "Gets the SmartChains & Bitcoin address of the node",
                {
                    args: {},
                    parser: async (args) => {
                        const reply: string[] = [];
                        for(let chainId in this.multichainData.chains) {
                            const {signer} = this.multichainData.chains[chainId];
                            reply.push(chainId+" address: "+signer.getAddress());
                        }

                        if(this.bitcoinWallet!=null) {
                            if(!this.bitcoinWallet.isReady()) {
                                reply.push("Bitcoin address: unknown (bitcoin wallet not ready)");
                            } else {
                                reply.push("Bitcoin address: "+await this.bitcoinWallet.getAddress());
                            }
                        }
                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "getbalance",
                "Gets the balances of the node",
                {
                    args: {},
                    parser: async (args) => {
                        const reply: string[] = [];
                        reply.push("Wallet balances (non-trading):");
                        for(let chainId in this.addressesToTokens) {
                            const {swapContract, signer} = this.multichainData.chains[chainId];
                            for(let tokenAddress in this.addressesToTokens[chainId]) {
                                const tokenData = this.addressesToTokens[chainId][tokenAddress];
                                const tokenBalance = await swapContract.getBalance(signer.getAddress(), tokenAddress, false);
                                reply.push("    "+this.toReadableToken(chainId, tokenData.ticker)+": "+toDecimal(tokenBalance, tokenData.decimals));
                            }
                        }
                        reply.push("LP Vault balances (trading):");
                        for(let chainId in this.addressesToTokens) {
                            const {swapContract, signer} = this.multichainData.chains[chainId];
                            for(let tokenAddress in this.addressesToTokens[chainId]) {
                                const tokenData = this.addressesToTokens[chainId][tokenAddress];
                                const tokenBalance = await swapContract.getBalance(signer.getAddress(),tokenAddress, true);
                                reply.push("    "+this.toReadableToken(chainId, tokenData.ticker)+": "+toDecimal(tokenBalance || 0n, tokenData.decimals));
                            }
                        }

                        if(this.bitcoinWallet!=null) {
                            reply.push("Bitcoin balances (trading):");
                            if(!this.bitcoinWallet.isReady()) {
                                reply.push("    BTC: unknown (bitcoin wallet not ready)");
                            } else {
                                const balances = await this.bitcoinWallet.getBalance();
                                reply.push("    BTC: "+toDecimal(BigInt(balances.confirmed), 8)+" (+"+toDecimal(BigInt(balances.unconfirmed), 8)+")");
                            }
                        }

                        if(this.lightningWallet!=null) {
                            if(!this.lightningWallet.isReady()) {
                                reply.push("    BTC-LN: unknown (lightning wallet not ready)");
                            } else {
                                const channelBalance = await this.lightningWallet.getLightningBalance();
                                reply.push("    BTC-LN: "+toDecimal(BigInt(channelBalance.localBalance), 8)+" (+"+toDecimal(BigInt(channelBalance.unsettledBalance), 8)+")");
                            }
                        }

                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "transfer",
                "Transfer wallet balance to an external address",
                {
                    args: {
                        asset: {
                            base: true,
                            description: "Asset to transfer: "+tokenTickers.concat(this.bitcoinWallet!=null ? ["BTC"] : []).join(", "),
                            parser: cmdEnumParser<string>(tokenTickers.concat(this.bitcoinWallet!=null ? ["BTC"] : []))
                        },
                        address: {
                            base: true,
                            description: "Destination address",
                            parser: cmdStringParser()
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to send",
                            parser: cmdStringParser(1)
                        },
                        feeRate: {
                            base: false,
                            description: "Fee rate: sats/vB for BTC",
                            parser: cmdNumberParser(false, 1, null, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(args.asset==="BTC") {
                            if(!this.bitcoinWallet.isReady()) throw new Error("Bitcoin wallet not ready yet! Monitor the status with the 'status' command");
                            const amtBN = fromDecimal(args.amount, 8);

                            const res = await this.bitcoinWallet.getSignedTransaction(args.address, Number(amtBN), args.feeRate);
                            await this.bitcoinWallet.sendRawTransaction(res.raw);

                            return "Transaction sent, txId: "+res.txId;
                        }

                        const {chainId, ticker} = this.fromReadableToken(args.asset);

                        const {chainInterface, signer} = this.multichainData.chains[chainId];
                        const tokenData = this.tokens[ticker].chains[chainId];
                        const amtBN = fromDecimal(args.amount, tokenData.decimals);

                        const txns = await chainInterface.txsTransfer(signer.getAddress(), tokenData.address, amtBN, args.address);
                        await chainInterface.sendAndConfirm(signer, txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return "Transfer transaction confirmed!";
                    }
                }
            ),
            createCommand(
                "deposit",
                "Deposits smartchain wallet balance to an LP Vault",
                {
                    args: {
                        asset: {
                            base: true,
                            description: "Asset to transfer: "+tokenTickers.join(", "),
                            parser: cmdEnumParser<string>(tokenTickers)
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to deposit",
                            parser: cmdStringParser(1)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const {chainId, ticker} = this.fromReadableToken(args.asset);

                        const {chainInterface, swapContract, signer} = this.multichainData.chains[chainId];
                        const tokenData = this.tokens[ticker].chains[chainId];

                        const amtBN = fromDecimal(args.amount, tokenData.decimals);

                        const txns = await swapContract.txsDeposit(signer.getAddress(), tokenData.address, amtBN);
                        await chainInterface.sendAndConfirm(signer, txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return "Deposit transaction confirmed!";
                    }
                }
            ),
            createCommand(
                "withdraw",
                "Withdraw LP Vault balance to node's SmartChain wallet",
                {
                    args: {
                        asset: {
                            base: true,
                            description: "Asset to withdraw: "+tokenTickers.join(", "),
                            parser: cmdEnumParser<string>(tokenTickers)
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to withdraw",
                            parser: cmdStringParser(1)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const {chainId, ticker} = this.fromReadableToken(args.asset);

                        const {chainInterface, swapContract, signer} = this.multichainData.chains[chainId];
                        const tokenData = this.tokens[ticker].chains[chainId];
                        console.log(typeof(args.amount), args.amount);
                        const amtBN = fromDecimal(args.amount, tokenData.decimals);

                        const txns = await swapContract.txsWithdraw(signer.getAddress(), tokenData.address, amtBN);
                        await chainInterface.sendAndConfirm(signer, txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return "Withdrawal transaction confirmed!";
                    }
                }
            ),
            createCommand(
                "getreputation",
                "Checks the LP node's reputation stats",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        const reply: string[] = [];
                        reply.push("LP node's reputation:");
                        for(let chainId in this.addressesToTokens) {
                            const {swapContract, signer} = this.multichainData.chains[chainId];
                            for(let tokenAddress in this.addressesToTokens[chainId]) {
                                const {ticker, decimals} = this.addressesToTokens[chainId][tokenAddress];

                                const reputation = await swapContract.getIntermediaryReputation(signer.getAddress(), tokenAddress);
                                if(reputation==null) {
                                    reply.push(this.toReadableToken(chainId, ticker)+": No reputation");
                                    continue;
                                }
                                reply.push(this.toReadableToken(chainId, ticker)+":");
                                const lnData = reputation[ChainSwapType.HTLC];
                                reply.push("   LN:");
                                reply.push("       successes: "+toDecimal(lnData.successVolume, decimals)+" ("+lnData.successCount.toString(10)+" swaps)");
                                reply.push("       fails: "+toDecimal(lnData.failVolume, decimals)+" ("+lnData.failCount.toString(10)+" swaps)");
                                reply.push("       coop closes: "+toDecimal(lnData.coopCloseVolume, decimals)+" ("+lnData.coopCloseCount.toString(10)+" swaps)");

                                const onChainData = reputation[ChainSwapType.CHAIN_NONCED];
                                reply.push("   On-chain:");
                                reply.push("       successes: "+toDecimal(onChainData.successVolume, decimals)+" ("+onChainData.successCount.toString(10)+" swaps)");
                                reply.push("       fails: "+toDecimal(onChainData.failVolume, decimals)+" ("+onChainData.failCount.toString(10)+" swaps)");
                                reply.push("       coop closes: "+toDecimal(onChainData.coopCloseVolume, decimals)+" ("+onChainData.coopCloseCount.toString(10)+" swaps)");
                            }
                        }
                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "plugins",
                "Shows the list of loaded plugins",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        const reply: string[] = [];
                        reply.push("Loaded plugins:");
                        for(let [name, plugin] of PluginManager.plugins.entries()) {
                            reply.push("    - "+name+" : "+(plugin.description || "No description"));
                        }
                        if(reply.length===1) reply.push("   No loaded plugins");
                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "geturl",
                "Returns the URL of the node (only works when SSL_AUTO mode is used)",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        if(IntermediaryConfig.SSL_AUTO==null) throw new Error("Node is not using SSL_AUTO mode for certificate provision!");
                        if(this.sslAutoUrl==null) throw new Error("Url not generated yet (node is still syncing?)");
                        return "Node url: "+this.sslAutoUrl;
                    }
                }
            ),
            createCommand(
                "register",
                "Registers the URL of the node to the public LP node registry (only works when SSL_AUTO mode is used)",
                {
                    args: {
                        mail: {
                            base: true,
                            description: "E-mail to use for the LP registration, if there is something wrong with your node we will contact you here (can be empty - \"\" to opt-out)!",
                            parser: cmdStringParser()
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(IntermediaryConfig.SSL_AUTO==null) throw new Error("Node is not using SSL_AUTO mode for certificate provision!");
                        if(this.sslAutoUrl==null) throw new Error("Url not generated yet (node is still syncing?)");
                        const isRegistering = await this.lpRegistry.isRegistering();
                        if(isRegistering) {
                            const {status, url} = await this.lpRegistry.getRegistrationStatus();
                            return "LP registration status: "+status+"\nGithub PR: "+url;
                        } else {
                            const network = IntermediaryConfig.BITCOIND.NETWORK;
                            if(network==="regtest") return "Not supported on regtest!";
                            const url = await this.lpRegistry.register(network, this.sslAutoUrl, args.mail==="" ? null : args.mail);
                            return "LP registration request created: "+url;
                        }
                    }
                }
            ),
            createCommand(
                "listswaps",
                "Lists all swaps in progress",
                {
                    args: {
                        quotes: {
                            base: false,
                            description: "Whether to also show issued quotes (not yet committed to swaps) - 0/1",
                            parser: cmdNumberParser(false, 0, 1, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const swapData: string[] = [];
                        for(let swapHandler of this.swapHandlers) {
                            for(let {obj: _swap} of await swapHandler.storageManager.query([])) {
                                const tokenData = this.addressesToTokens[_swap.chainIdentifier][_swap.getToken().toString()];
                                if(_swap.type===SwapHandlerType.TO_BTC) {
                                    const swap = _swap as ToBtcSwapAbs;
                                    if(args.quotes!==1 && swap.state===ToBtcSwapState.SAVED) continue;
                                    const lines = [
                                        toDecimal(swap.data.getAmount(), tokenData.decimals)+" "+tokenData.ticker+" -> "+toDecimal(swap.amount, 8)+" BTC",
                                        "Identifier hash: "+_swap.getIdentifierHash(),
                                        "Escrow hash: "+_swap.getEscrowHash(),
                                        "Claim hash: "+_swap.getClaimHash(),
                                        "State: "+ToBtcSwapState[swap.state],
                                        "Swap fee: "+toDecimal(swap.swapFee, 8)+" BTC",
                                        "Network fee: "+toDecimal(swap.quotedNetworkFee, 8)+" BTC",
                                        "Address: "+swap.address
                                    ];
                                    if(swap.txId!=null) {
                                        lines.push("Tx ID: "+swap.txId);
                                        lines.push("Paid network fee: "+toDecimal(swap.realNetworkFee, 8)+" BTC");
                                    }
                                    swapData.push(lines.join("\n"));
                                }
                                if(_swap.type===SwapHandlerType.TO_BTCLN) {
                                    const swap = _swap as ToBtcLnSwapAbs;
                                    if(args.quotes!==1 && swap.state===ToBtcLnSwapState.SAVED) continue;
                                    const parsedPR = bolt11.decode(swap.pr);
                                    const sats = BigInt(parsedPR.millisatoshis) / 1000n;
                                    const lines = [
                                        toDecimal(swap.data.getAmount(), tokenData.decimals)+" "+tokenData.ticker+" -> "+toDecimal(sats, 8)+" BTC-LN",
                                        "Identifier hash: "+_swap.getIdentifierHash(),
                                        "Escrow hash: "+_swap.getEscrowHash(),
                                        "Claim hash: "+_swap.getClaimHash(),
                                        "State: "+ToBtcLnSwapState[swap.state],
                                        "Swap fee: "+toDecimal(swap.swapFee, 8)+" BTC-LN",
                                        "Network fee: "+toDecimal(swap.quotedNetworkFee, 8)+" BTC-LN",
                                        "Invoice: "+swap.pr,
                                    ];
                                    if(swap.realNetworkFee!=null) {
                                        lines.push("Paid network fee: "+toDecimal(swap.realNetworkFee, 8)+" BTC-LN");
                                    }
                                    swapData.push(lines.join("\n"));
                                }
                                if(_swap.type===SwapHandlerType.FROM_BTC) {
                                    const swap = _swap as FromBtcSwapAbs;
                                    if(args.quotes!==1 && swap.state===FromBtcSwapState.CREATED) continue;
                                    const lines = [
                                        toDecimal(swap.amount, 8)+" BTC -> "+toDecimal(swap.data.getAmount(), tokenData.decimals)+" "+tokenData.ticker,
                                        "Identifier hash: "+_swap.getIdentifierHash(),
                                        "Escrow hash: "+_swap.getEscrowHash(),
                                        "Claim hash: "+_swap.getClaimHash(),
                                        "State: "+FromBtcSwapState[swap.state],
                                        "Swap fee: "+toDecimal(swap.swapFee, 8)+" BTC",
                                        "Receiving address: "+swap.address
                                    ];
                                    swapData.push(lines.join("\n"));
                                }
                                if(_swap.type===SwapHandlerType.FROM_BTCLN) {
                                    const swap = _swap as FromBtcLnSwapAbs;
                                    if(args.quotes!==1 && swap.state===FromBtcLnSwapState.CREATED) continue;
                                    const parsedPR = bolt11.decode(swap.pr);
                                    const sats = BigInt(parsedPR.millisatoshis) / 1000n;
                                    const lines = [
                                        toDecimal(sats, 8)+" BTC-LN -> "+toDecimal(swap.getOutputAmount(), tokenData.decimals)+" "+tokenData.ticker,
                                        "Identifier hash: "+_swap.getIdentifierHash(),
                                        "Escrow hash: "+_swap.getEscrowHash(),
                                        "Claim hash: "+_swap.getClaimHash(),
                                        "State: "+FromBtcLnSwapState[swap.state],
                                        "Swap fee: "+toDecimal(swap.swapFee, 8)+" BTC-LN",
                                        "Receiving invoice: "+swap.pr
                                    ];
                                    swapData.push(lines.join("\n"));
                                }
                            }
                        }
                        return swapData.join("\n\n");
                    }
                }
            )
        ];

        if(this.bitcoinWallet!=null) {
            this.bitcoinWallet.getCommands().forEach(cmd => commands.push(cmd));
        }

        if(this.lightningWallet!=null) {
            this.lightningWallet.getCommands().forEach(cmd => commands.push(cmd));
            commands.push(
                createCommand(
                    "transferlightning",
                    "Transfer lightning wallet balance, pay lightning network invoice",
                    {
                        args: {
                            invoice: {
                                base: true,
                                description: "Lightning network invoice to pay (must specify an amount!)",
                                parser: cmdStringParser()
                            }
                        },
                        parser: async (args, sendLine) => {
                            if(!this.lightningWallet.isReady()) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                            const parsedInvoice = await this.lightningWallet.parsePaymentRequest(args.invoice);
                            sendLine("Sending lightning tx "+parsedInvoice.id+"...");
                            await this.lightningWallet.pay({
                                request: args.invoice,
                            });
                            sendLine("Waiting for confirmation...");
                            const resp = await this.lightningWallet.waitForPayment(parsedInvoice.id);
                            if(resp.status==="confirmed") {
                                return "Lightning transaction confirmed! Preimage: "+resp.secret;
                            }
                            if(resp.status==="failed") {
                                return "Lightning failed! No bitcoin was send";
                            }
                            return "Lightning transaction is taking longer than expected, will be handled in the background!";
                        }
                    }
                )
            );
            commands.push(
                createCommand(
                    "receivelightning",
                    "Creates a lightning network invoice",
                    {
                        args: {
                            amount: {
                                base: true,
                                description: "Amount of BTC to receive over lightning",
                                parser: cmdNumberParser(true, 0, null, true)
                            }
                        },
                        parser: async (args, sendLine) => {
                            if(!this.lightningWallet.isReady()) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                            const amtBN = args.amount==null ? null : fromDecimal(args.amount.toFixed(8), 8);
                            const resp = await this.lightningWallet.createInvoice({
                                mtokens: amtBN==null ? undefined : amtBN * 1000n
                            });
                            return "Lightning network invoice: "+resp.request;
                        }
                    }
                )
            );
        }

        if(this.spvVaultSigner!=null) {
            commands.push(
                createCommand(
                    "listvaults",
                    "Lists created spv vaults",
                    {
                        args: {
                            chainId: {
                                base: true,
                                description: "Chain ID to check spv vaults of",
                                parser: cmdEnumParser<string>(allowedChains, true)
                            },
                            asset: {
                                base: true,
                                description: "Asset to check spv vaults of",
                                parser: cmdStringParser(undefined, undefined, true)
                            }
                        },
                        parser: async (args, sendLine) => {
                            if(args.asset!=null && args.chainId==null) throw new Error("Chain ID needs to be specified when requesting specific asset");

                            const vaults = await this.spvSwapHandler.Vaults.listVaults(
                                args.chainId,
                                args.asset==null ? null : this.tokens[args.asset].chains[args.chainId].address
                            );

                            const assortedVaults: {
                                [chainId: string]: {
                                    [ticker: string]: SpvVault[]
                                }
                            } = {};

                            vaults.forEach(vault => {
                                assortedVaults[vault.chainId] ??= {};
                                const tokenData = this.addressesToTokens[vault.chainId][vault.data.getTokenData()[0].token];
                                assortedVaults[vault.chainId][tokenData.ticker] ??= [];
                                assortedVaults[vault.chainId][tokenData.ticker].push(vault);
                            });

                            for(let chainId in assortedVaults) {
                                for(let ticker in assortedVaults[chainId]) {
                                    sortVaults(assortedVaults[chainId][ticker]);
                                }
                            }

                            const lines: string[] = [];
                            for (let chainId in assortedVaults) {
                                lines.push(chainId+":")
                                for (let ticker in assortedVaults[chainId]) {
                                    lines.push("    "+ticker+":");
                                    const vaults = assortedVaults[chainId][ticker];
                                    vaults.sort(
                                        (a, b) => bigIntSorter(a.data.getVaultId(), b.data.getVaultId())
                                    );
                                    const tokenData = this.tokens[ticker].chains[chainId];
                                    vaults.forEach((vault, index) => {
                                        const gasTokenData = this.addressesToTokens[chainId][vault.balances[1].token];
                                        lines.push("        Vault "+index+":");
                                        lines.push("            State: "+SpvVaultState[vault.state]);
                                        lines.push("            Vault ID: "+vault.data.getVaultId());
                                        lines.push("            Balance: "+toDecimal(vault.balances[0].scaledAmount, tokenData.decimals)+" "+ticker);
                                        lines.push("            Gas balance: "+toDecimal(vault.balances[1].scaledAmount, gasTokenData.decimals)+" "+gasTokenData.ticker);
                                        lines.push("            Required confirmations: "+vault.data.getConfirmations());
                                        lines.push("            Withdrawal count: "+vault.data.getWithdrawalCount());
                                        lines.push("            Latest SC UTXO: "+vault.data.getUtxo());
                                        lines.push("            Latest UTXO: "+vault.getLatestUtxo());
                                        lines.push("            Pending withdrawals ("+vault.pendingWithdrawals.length+"):");
                                        vault.pendingWithdrawals.forEach(withdrawal => {
                                            const amounts = vault.fromRawAmounts(withdrawal.getTotalOutput());
                                            lines.push("                "+withdrawal.getTxId()+":");
                                            lines.push("                    Amount: "+toDecimal(amounts[0], tokenData.decimals)+" "+ticker);
                                            lines.push("                    Gas amount: "+toDecimal(amounts[1], gasTokenData.decimals)+" "+gasTokenData.ticker);
                                        });
                                    });
                                }
                            }

                            return lines.join("\n");
                        }
                    }
                )
            );
            commands.push(
                createCommand(
                    "createvaults",
                    "Creates new spv vaults",
                    {
                        args: {
                            asset: {
                                base: true,
                                description: "Asset to create a vault for: "+tokenTickers.join(", "),
                                parser: cmdEnumParser<string>(tokenTickers)
                            },
                            count: {
                                base: true,
                                description: "How many vaults to create",
                                parser: cmdNumberParser(false, 1, 100, true)
                            },
                            feeRate: {
                                base: false,
                                description: "Fee rate: sats/vB for BTC transaction",
                                parser: cmdNumberParser(false, 1, null, true)
                            }
                        },
                        parser: async (args, sendLine) => {
                            const {chainId, ticker} = this.fromReadableToken(args.asset);

                            const count = args.count ?? 1;

                            const tokenData = this.tokens[ticker].chains[chainId];
                            const result= await this.spvSwapHandler.Vaults.createVaults(chainId, count, tokenData.address, undefined, args.feeRate);

                            return "Created "+count+" new vaults, vaults will be opened as soon as the bitcoin transaction gets enough confirmations! Bitcoin txId: "+result.btcTxId;
                        }
                    }
                )
            );
            commands.push(
                createCommand(
                    "depositvault",
                    "Deposits funds to the specific spv vault",
                    {
                        args: {
                            asset: {
                                base: true,
                                description: "Asset to fund the vault with: "+tokenTickers.join(", "),
                                parser: cmdEnumParser<string>(tokenTickers)
                            },
                            vaultId: {
                                base: true,
                                description: "Vault ID to fund",
                                parser: cmdNumberParser(false, 0, undefined, false)
                            },
                            amount: {
                                base: true,
                                description: "Amount of the token to deposit",
                                parser: cmdStringParser(1)
                            },
                            gasAmount: {
                                base: true,
                                description: "Amount of the gas token to deposit",
                                parser: cmdStringParser(1, undefined, true)
                            }
                        },
                        parser: async (args, sendLine) => {
                            const {chainId, ticker} = this.fromReadableToken(args.asset);
                            const tokenData = this.tokens[ticker].chains[chainId];
                            const amountToken0 = fromDecimal(args.amount, tokenData.decimals);

                            const vaults = await this.spvSwapHandler.Vaults.listVaults(chainId, tokenData.address);
                            sortVaults(vaults);

                            const vault: SpvVault = vaults[args.vaultId];
                            if(vault==null) throw new Error("Vault with id "+args.vaultId+" not found!");
                            if(!vault.data.isOpened()) throw new Error("Vault is not opened yet!");

                            const gasTokenData = this.addressesToTokens[chainId][vault.balances[1].token];
                            let amountToken1: bigint = 0n;
                            if(args.gasAmount!=null) {
                                amountToken1 = fromDecimal(args.gasAmount, gasTokenData.decimals);
                            }

                            const rawAmounts = vault.toRawAmounts([amountToken0, amountToken1]);
                            const adjustedAmounts = vault.fromRawAmounts(rawAmounts);
                            sendLine("Amounts scaled and adjusted, depositing: "+
                                toDecimal(adjustedAmounts[0], tokenData.decimals)+" "+ticker+" & "+
                                toDecimal(adjustedAmounts[1], gasTokenData.decimals)+" "+gasTokenData.ticker);

                            const result = await this.spvSwapHandler.Vaults.fundVault(vault, rawAmounts);

                            return "Funds deposited! Transaction ID: "+result;
                        }
                    }
                )
            );

            commands.push(
                createCommand(
                    "withdrawvault",
                    "Withdraw funds from the specific spv vault",
                    {
                        args: {
                            asset: {
                                base: true,
                                description: "Asset to fund the vault with: "+tokenTickers.join(", "),
                                parser: cmdEnumParser<string>(tokenTickers)
                            },
                            vaultId: {
                                base: true,
                                description: "Vault ID to fund",
                                parser: cmdNumberParser(false, 0, undefined, false)
                            },
                            amount: {
                                base: true,
                                description: "Amount of the token to withdraw",
                                parser: cmdStringParser(1)
                            },
                            gasAmount: {
                                base: true,
                                description: "Amount of the gas token to withdraw",
                                parser: cmdStringParser(1, undefined, true)
                            },
                            feeRate: {
                                base: false,
                                description: "Fee rate: sats/vB for BTC transaction",
                                parser: cmdNumberParser(false, 1, null, true)
                            }
                        },
                        parser: async (args, sendLine) => {
                            const {chainId, ticker} = this.fromReadableToken(args.asset);
                            const tokenData = this.tokens[ticker].chains[chainId];
                            const amountToken0 = fromDecimal(args.amount, tokenData.decimals);

                            const vaults = await this.spvSwapHandler.Vaults.listVaults(chainId, tokenData.address);
                            sortVaults(vaults);

                            const vault: SpvVault = vaults[args.vaultId];
                            if(vault==null) throw new Error("Vault with id "+args.vaultId+" not found!");
                            if(!vault.data.isOpened()) throw new Error("Vault is not opened yet!");

                            const gasTokenData = this.addressesToTokens[chainId][vault.balances[1].token];
                            let amountToken1: bigint = 0n;
                            if(args.gasAmount!=null) {
                                amountToken1 = fromDecimal(args.gasAmount, gasTokenData.decimals);
                            }

                            const rawAmounts = vault.toRawAmounts([amountToken0, amountToken1]);
                            const adjustedAmounts = vault.fromRawAmounts(rawAmounts);
                            sendLine("Amounts scaled and adjusted, withdrawing: "+
                                toDecimal(adjustedAmounts[0], tokenData.decimals)+" "+ticker+" & "+
                                toDecimal(adjustedAmounts[1], gasTokenData.decimals)+" "+gasTokenData.ticker);

                            const result = await this.spvSwapHandler.Vaults.withdrawFromVault(vault, rawAmounts, args.feeRate);

                            return "Funds withdrawal initiated, funds will be automatically claimed when bitcoin transaction gets "+
                                vault.data.getConfirmations()+" confirmations! Bitcoin transaction ID: "+result;
                        }
                    }
                )
            );
        }

        this.cmdHandler = new CommandHandler(commands, IntermediaryConfig.CLI.ADDRESS, IntermediaryConfig.CLI.PORT, "Welcome to atomiq intermediary (LP node) CLI!");
    }

    async init() {
        await this.cmdHandler.init();
        await super.init();
        for(let plugin of PluginManager.plugins.values()) {
            if(plugin.getCommands!=null) {
                plugin.getCommands().forEach(cmd => this.cmdHandler.registerCommand(cmd));
            }
        }
    }

}