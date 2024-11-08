import {BitcoinRpc, ChainSwapType} from "crosslightning-base";
import {
    FromBtcLnSwapAbs,
    FromBtcLnSwapState,
    FromBtcSwapAbs,
    FromBtcSwapState,
    ISwapPrice, MultichainData,
    PluginManager,
    SwapHandlerType,
    ToBtcLnSwapAbs,
    ToBtcLnSwapState,
    ToBtcSwapAbs,
    ToBtcSwapState
} from "crosslightning-intermediary";
import {IntermediaryRunner} from "./IntermediaryRunner";
import * as BN from "bn.js";
import {
    cmdEnumParser,
    cmdNumberParser,
    cmdStringParser,
    CommandHandler,
    createCommand
} from "crosslightning-server-base";
import {getP2wpkhPubkey, getUnauthenticatedLndGrpc} from "../btc/LND";
import * as lncli from "ln-service";
import {fromDecimal, toDecimal} from "../Utils";
import * as bitcoin from "bitcoinjs-lib";
import {BITCOIN_NETWORK} from "../constants/Constants";
import {IntermediaryConfig} from "../IntermediaryConfig";
import {Registry} from "../Registry";
import * as bolt11 from "bolt11";
import {UnauthenticatedLnd} from "lightning";

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
        bitcoinRpc: BitcoinRpc<any>
    ) {
        super(directory, multichainData, tokens, prices, bitcoinRpc);
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
        this.cmdHandler = new CommandHandler([
            createCommand(
                "status",
                "Fetches the current status of the bitcoin RPC, LND gRPC & intermediary application",
                {
                    args: {},
                    parser: async (args) => {
                        const reply: string[] = [];

                        reply.push("SmartChains status:");
                        for(let chainId in this.multichainData.chains) {
                            const swapContract = this.multichainData.chains[chainId].swapContract;
                            const nativeTokenAddress = swapContract.getNativeCurrencyAddress();
                            const {decimals, ticker} = this.addressesToTokens[chainId][nativeTokenAddress.toString()];
                            let nativeTokenBalance: BN;
                            try {
                                nativeTokenBalance = await swapContract.getBalance(nativeTokenAddress, false);
                            } catch (e) {
                                console.error(e);
                            }
                            reply.push("    "+chainId+":");
                            reply.push("        RPC status: "+(nativeTokenBalance!=null ? "ready" : "offline!"));
                            if(nativeTokenBalance!=null) {
                                reply.push("        Funds: " + toDecimal(nativeTokenBalance, decimals)+" "+ticker);
                                reply.push("        Has enough funds (>0.1): " + (nativeTokenBalance.gt(new BN(100000000)) ? "yes" : "no"));
                            }
                        }

                        const btcRpcStatus = await this.bitcoinRpc.getSyncInfo().catch(e => null);
                        reply.push("Bitcoin RPC status:");
                        reply.push("    Status: "+(btcRpcStatus==null ? "offline" : btcRpcStatus.ibd ? "verifying blockchain" : "ready"));
                        if(btcRpcStatus!=null) {
                            reply.push("    Verification progress: "+(btcRpcStatus.verificationProgress*100).toFixed(4)+"%");
                            reply.push("    Synced headers: "+btcRpcStatus.headers);
                            reply.push("    Synced blocks: "+btcRpcStatus.blocks);
                        }

                        let lndRpcStatus = "offline";
                        try {
                            const unauthenticatedRpc = getUnauthenticatedLndGrpc();
                            lndRpcStatus =  await this.getLNDWalletStatus(unauthenticatedRpc);
                        } catch (e) {
                            console.error(e);
                        }
                        reply.push("LND gRPC status:");
                        reply.push("    Wallet status: "+lndRpcStatus);
                        if(lndRpcStatus!="offline") {
                            try {
                                const resp = await lncli.getWalletInfo({
                                    lnd: this.LND
                                });
                                reply.push("    Synced to chain: "+resp.is_synced_to_chain);
                                reply.push("    Blockheight: "+resp.current_block_height);
                                reply.push("    Connected peers: "+resp.peers_count);
                                reply.push("    Channels active: "+resp.active_channels_count);
                                reply.push("    Channels pending: "+resp.pending_channels_count);
                                reply.push("    Node pubkey: "+resp.public_key);
                            } catch (e) {
                                console.error(e);
                            }
                        }

                        reply.push("Intermediary status: "+this.initState);

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
                            const swapContract = this.multichainData.chains[chainId].swapContract;
                            reply.push(chainId+" address: "+swapContract.getAddress());
                        }

                        let bitcoinAddress: string;
                        let lnd: UnauthenticatedLnd;
                        try {
                            lnd = getUnauthenticatedLndGrpc();
                        } catch (e) {
                            console.error(e);
                        }
                        if(lnd!=null && this.LND!=null) {
                            const walletStatus = await this.getLNDWalletStatus(lnd);
                            if(walletStatus==="active") {
                                const synced = await this.isLNDSynced();
                                if(synced) {
                                    const resp = await lncli.createChainAddress({
                                        lnd: this.LND,
                                        format: "p2wpkh"
                                    }).catch(e => console.error(e));
                                    if(resp!=null) {
                                        bitcoinAddress = resp.address;
                                    }
                                }
                            }
                        }

                        if(bitcoinAddress==null) {
                            const pubkey = getP2wpkhPubkey();
                            if(pubkey!=null) {
                                const address = bitcoin.payments.p2wpkh({
                                    pubkey,
                                    network: BITCOIN_NETWORK
                                }).address;
                                bitcoinAddress = address;
                            } else {
                                reply.push("Bitcoin address: unknown (LND node unresponsive - not initialized?)");
                                return reply.join("\n");
                            }
                        }

                        reply.push("Bitcoin address: "+bitcoinAddress);
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
                            const swapContract = this.multichainData.chains[chainId].swapContract;
                            for(let tokenAddress in this.addressesToTokens[chainId]) {
                                const tokenData = this.addressesToTokens[chainId][tokenAddress];
                                const tokenBalance = await swapContract.getBalance(swapContract.toTokenAddress(tokenAddress), false);
                                reply.push("   "+this.toReadableToken(chainId, tokenData.ticker)+": "+toDecimal(tokenBalance, tokenData.decimals));
                            }
                        }
                        reply.push("LP Vault balances (trading):");
                        for(let chainId in this.addressesToTokens) {
                            const swapContract = this.multichainData.chains[chainId].swapContract;
                            for(let tokenAddress in this.addressesToTokens[chainId]) {
                                const tokenData = this.addressesToTokens[chainId][tokenAddress];
                                const tokenBalance = await swapContract.getBalance(swapContract.toTokenAddress(tokenAddress), true);
                                reply.push("   "+this.toReadableToken(chainId, tokenData.ticker)+": "+toDecimal(tokenBalance || new BN(0), tokenData.decimals));
                            }
                        }

                        reply.push("Bitcoin balances (trading):");
                        const utxoResponse = await lncli.getUtxos({lnd: this.LND, min_confirmations: 0}).catch(e => console.error(e));
                        if(utxoResponse==null) {
                            reply.push("   BTC: unknown"+" (waiting for bitcoin node sync)");
                        } else {
                            let unconfirmed = new BN(0);
                            let confirmed = new BN(0);
                            utxoResponse.utxos.forEach(utxo => {
                                if(utxo.confirmation_count===0) {
                                    unconfirmed = unconfirmed.add(new BN(utxo.tokens));
                                } else {
                                    confirmed = confirmed.add(new BN(utxo.tokens));
                                }
                            });
                            reply.push("   BTC: "+toDecimal(confirmed, 8)+" (+"+toDecimal(unconfirmed, 8)+")");
                        }

                        const channelBalance = await lncli.getChannelBalance({lnd: this.LND}).catch(e => console.error(e));
                        if(channelBalance==null) {
                            reply.push("   BTC-LN: unknown (waiting for bitcoin node sync)");
                        } else {
                            reply.push("   BTC-LN: "+toDecimal(new BN(channelBalance.channel_balance), 8)+" (+"+toDecimal(new BN(channelBalance.pending_balance), 8)+")");
                        }

                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "connectlightning",
                "Connect to a lightning node peer",
                {
                    args: {
                        node: {
                            base: true,
                            description: "Remote node identification as <pubkey>@<ip address>",
                            parser: (data: string) => {
                                if(data==null) throw new Error("Data cannot be null");
                                const arr = data.split("@");
                                if(arr.length!==2) throw new Error("Invalid format, should be: <pubkey>@<ip address>");
                                return {
                                    pubkey: arr[0],
                                    address: arr[1]
                                };
                            }
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        sendLine("Connecting to remote peer...");
                        await lncli.addPeer({
                            lnd: this.LND,
                            public_key: args.node.pubkey,
                            socket: args.node.address
                        });
                        return "Connection to the lightning peer established! Public key: "+args.node.pubkey;
                    }
                }
            ),
            createCommand(
                "openchannel",
                "Opens up a lightning network payment channel",
                {
                    args: {
                        amount: {
                            base: true,
                            description: "Amount of BTC to use inside a lightning",
                            parser: cmdNumberParser(true, 0)
                        },
                        node: {
                            base: true,
                            description: "Remote node identification as <pubkey>@<ip address>",
                            parser: (data: string) => {
                                if(data==null) throw new Error("Data cannot be null");
                                const arr = data.split("@");
                                if(arr.length!==2) throw new Error("Invalid format, should be: <pubkey>@<ip address>");
                                return {
                                    pubkey: arr[0],
                                    address: arr[1]
                                };
                            }
                        },
                        feeRate: {
                            base: false,
                            description: "Fee rate for the opening transaction (sats/vB)",
                            parser: cmdNumberParser(false, 1, null, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        const amtBN = args.amount==null ? null : fromDecimal(args.amount.toFixed(8), 8);
                        if(amtBN==null) throw new Error("Amount cannot be parsed");
                        const resp = await lncli.openChannel({
                            lnd: this.LND,
                            local_tokens: amtBN.toNumber(),
                            min_confirmations: 0,
                            partner_public_key: args.node.pubkey,
                            partner_socket: args.node.address,
                            fee_rate: 1000,
                            base_fee_mtokens: "1000",
                            chain_fee_tokens_per_vbyte: args.feeRate
                        });
                        return "Lightning channel funded, wait for TX confirmations! txId: "+resp.transaction_id;
                    }
                }
            ),
            createCommand(
                "closechannel",
                "Attempts to cooperatively close a lightning network channel",
                {
                    args: {
                        channelId: {
                            base: true,
                            description: "Channel ID to close cooperatively",
                            parser: cmdStringParser()
                        },
                        feeRate: {
                            base: false,
                            description: "Fee rate for the opening transaction (sats/vB)",
                            parser: cmdNumberParser(false, 1, null, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        const resp = await lncli.closeChannel({
                            lnd: this.LND,
                            is_force_close: false,
                            id: args.channelId,
                            tokens_per_vbyte: args.feeRate
                        });
                        return "Lightning channel closed, txId: "+resp.transaction_id;
                    }
                }
            ),
            createCommand(
                "forceclosechannel",
                "Force closes a lightning network channel",
                {
                    args: {
                        channelId: {
                            base: true,
                            description: "Channel ID to force close",
                            parser: cmdStringParser()
                        },
                        feeRate: {
                            base: false,
                            description: "Fee rate for the opening transaction (sats/vB)",
                            parser: cmdNumberParser(false, 1, null, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        const resp = await lncli.closeChannel({
                            lnd: this.LND,
                            is_force_close: true,
                            id: args.channelId,
                            tokens_per_vbyte: args.feeRate
                        });
                        return "Lightning channel closed, txId: "+resp.transaction_id;
                    }
                }
            ),
            createCommand(
                "listchannels",
                "Lists existing lightning channels",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        const {channels} = await lncli.getChannels({
                            lnd: this.LND
                        });
                        const reply: string[] = [];
                        reply.push("Opened channels:");
                        for(let channel of channels) {
                            reply.push(" - "+channel.id);
                            reply.push("    Peer: "+channel.partner_public_key);
                            reply.push("    State: "+(channel.is_closing ? "closing" : channel.is_opening ? "opening" : channel.is_active ? "active" : "inactive"));
                            reply.push("    Balance: "+toDecimal(new BN(channel.local_balance), 8)+"/"+toDecimal(new BN(channel.capacity), 8)+" ("+(channel.local_balance/channel.capacity*100).toFixed(2)+"%)");
                            reply.push("    Unsettled balance: "+toDecimal(new BN(channel.unsettled_balance), 8));
                        }
                        const {pending_channels} = await lncli.getPendingChannels({
                            lnd: this.LND
                        });
                        if(pending_channels.length>0) {
                            reply.push("Pending channels:");
                            for(let channel of pending_channels) {
                                reply.push(" - "+channel.transaction_id+":"+channel.transaction_vout);
                                reply.push("    Peer: "+channel.partner_public_key);
                                reply.push("    State: "+(channel.is_closing ? "closing" : channel.is_opening ? "opening" : channel.is_active ? "active" : "inactive"));
                                reply.push("    Balance: "+toDecimal(new BN(channel.local_balance), 8)+"/"+toDecimal(new BN(channel.capacity), 8)+" ("+(channel.local_balance/channel.capacity*100).toFixed(2)+"%)");
                                if(channel.is_opening) reply.push("    Funding txId: "+channel.transaction_id);
                                if(channel.is_closing) {
                                    reply.push("    Is timelocked: "+channel.is_timelocked);
                                    if(channel.is_timelocked) reply.push("    Blocks till claimable: "+channel.timelock_blocks);
                                    reply.push("    Close txId: "+channel.close_transaction_id);
                                }
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
                            description: "Asset to transfer: "+tokenTickers.concat(["BTC"]).join(", "),
                            parser: cmdEnumParser<string>(tokenTickers.concat(["BTC"]))
                        },
                        address: {
                            base: true,
                            description: "Destination address",
                            parser: cmdStringParser()
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to send",
                            parser: cmdNumberParser(true, 0)
                        },
                        feeRate: {
                            base: false,
                            description: "Fee rate: sats/vB for BTC",
                            parser: cmdNumberParser(false, 1, null, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(args.asset==="BTC") {
                            if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                            const amtBN = fromDecimal(args.amount.toFixed(8), 8);

                            const resp = await lncli.sendToChainAddress({
                                lnd: this.LND,
                                tokens: amtBN.toNumber(),
                                address: args.address,
                                utxo_confirmations: 0,
                                fee_tokens_per_vbyte: args.feeRate
                            });

                            return "Transaction sent, txId: "+resp.id;
                        }

                        const {chainId, ticker} = this.fromReadableToken(args.asset);

                        const swapContract = this.multichainData.chains[chainId].swapContract;
                        const tokenData = this.tokens[ticker].chains[chainId];
                        const amtBN = fromDecimal(args.amount.toFixed(tokenData.decimals), tokenData.decimals);

                        const txns = await swapContract.txsTransfer(tokenData.address, amtBN, args.address);
                        await swapContract.sendAndConfirm(txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return "Transfer transaction confirmed!";
                    }
                }
            ),
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
                        if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        sendLine("Sending lightning tx, waiting for confirmation...");
                        const resp = await lncli.pay({
                            lnd: this.LND,
                            request: args.invoice
                        });
                        if(resp.is_confirmed) {
                            return "Lightning transaction confirmed! Preimage: "+resp.secret;
                        }
                        return "Lightning transaction is taking longer than expected, will be handled in the background!";
                    }
                }
            ),
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
                        if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        const amtBN = args.amount==null ? null : fromDecimal(args.amount.toFixed(8), 8);
                        const resp = await lncli.createInvoice({
                            lnd: this.LND,
                            mtokens: amtBN==null ? undefined : amtBN.mul(new BN(1000)).toString(10)
                        });
                        return "Lightning network invoice: "+resp.request;
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
                            description: "Amount of the currency to send",
                            parser: cmdNumberParser(true, 0)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const {chainId, ticker} = this.fromReadableToken(args.asset);

                        const swapContract = this.multichainData.chains[chainId].swapContract;
                        const tokenData = this.tokens[ticker].chains[chainId];

                        const amtBN = fromDecimal(args.amount.toFixed(tokenData.decimals), tokenData.decimals);

                        const txns = await swapContract.txsDeposit(tokenData.address, amtBN);
                        await swapContract.sendAndConfirm(txns, true, null, null, (txId: string) => {
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
                            description: "Asset to transfer: "+tokenTickers.join(", "),
                            parser: cmdEnumParser<string>(tokenTickers)
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to send",
                            parser: cmdNumberParser(true, 0)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const {chainId, ticker} = this.fromReadableToken(args.asset);

                        const swapContract = this.multichainData.chains[chainId].swapContract;
                        const tokenData = this.tokens[ticker].chains[chainId];
                        const amtBN = fromDecimal(args.amount.toFixed(tokenData.decimals), tokenData.decimals);

                        const txns = await swapContract.txsWithdraw(tokenData.address, amtBN);
                        await swapContract.sendAndConfirm(txns, true, null, null, (txId: string) => {
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
                            const swapContract = this.multichainData.chains[chainId].swapContract;
                            for(let tokenAddress in this.addressesToTokens[chainId]) {
                                const {ticker, decimals} = this.addressesToTokens[chainId][tokenAddress];

                                const reputation = await swapContract.getIntermediaryReputation(swapContract.getAddress(), swapContract.toTokenAddress(tokenAddress));
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

                                const onChainData = reputation[ChainSwapType.CHAIN];
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
                            const url = await this.lpRegistry.register(IntermediaryConfig.BITCOIND.NETWORK==="testnet", this.sslAutoUrl, args.mail==="" ? null : args.mail);
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
                            for(let _swap of await swapHandler.storageManager.query([])) {
                                const tokenData = this.addressesToTokens[_swap.chainIdentifier][_swap.data.getToken().toString()];
                                if(_swap.type===SwapHandlerType.TO_BTC) {
                                    const swap = _swap as ToBtcSwapAbs;
                                    if(args.quotes!==1 && swap.state===ToBtcSwapState.SAVED) continue;
                                    const lines = [
                                        toDecimal(swap.data.getAmount(), tokenData.decimals)+" "+tokenData.ticker+" -> "+toDecimal(swap.amount, 8)+" BTC",
                                        "Payment hash: "+_swap.data.getHash(),
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
                                    const sats = new BN(parsedPR.millisatoshis).div(new BN(1000));
                                    const lines = [
                                        toDecimal(swap.data.getAmount(), tokenData.decimals)+" "+tokenData.ticker+" -> "+toDecimal(sats, 8)+" BTC-LN",
                                        "Payment hash: "+_swap.data.getHash(),
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
                                        "Payment hash: "+_swap.data.getHash(),
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
                                    const sats = new BN(parsedPR.millisatoshis).div(new BN(1000));
                                    const lines = [
                                        toDecimal(sats, 8)+" BTC-LN -> "+toDecimal(swap.data.getAmount(), tokenData.decimals)+" "+tokenData.ticker,
                                        "Payment hash: "+_swap.data.getHash(),
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
        ], IntermediaryConfig.CLI.ADDRESS, IntermediaryConfig.CLI.PORT, "Welcome to atomiq intermediary (LP node) CLI!");
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