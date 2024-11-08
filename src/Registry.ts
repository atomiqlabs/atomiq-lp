import {fetch} from "cross-fetch";
import * as fs from "fs/promises";

export class Registry {

    readonly registryFile: string;

    constructor(registryFile: string) {
        this.registryFile = registryFile;
    }

    async register(testnet: boolean, url: string, mail?: string): Promise<string> {
        const prNumberTxt = await fs.readFile(this.registryFile).catch(e => null);
        if(prNumberTxt!=null) throw new Error("Already registered or waiting for registration!");

        const resp = await fetch("https://xrbhog4g8g.execute-api.eu-west-2.amazonaws.com/prod/prb0t", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-cache"
            },
            body: JSON.stringify({
                "user": "adambor",
                "repo": "SolLightning-registry",
                "description": "An automatically generated request for adding a new LP to the atomiq registry, mail: "+(
                    mail==null
                        ? "None"
                        : mail.replace(new RegExp("\@", 'g'), "(at)").replace(new RegExp("\\.", 'g'), "(dot)")
                ),
                "title": (testnet ? "[Testnet]" : "[Mainnet]")+" Add new LP node: "+url,
                "commit": "Add new LP node URL",
                "files": [
                    {"path": (testnet ? "testnet/" : "mainnet/")+new URL(url).hostname+".txt", "content": url}
                ]
            })
        });

        if(!resp.ok) throw new Error("Failed to register the node on the registry!");

        const obj = await resp.json();

        const prNumber = obj.number;

        await fs.writeFile(this.registryFile, prNumber.toString(10));

        return "https://github.com/adambor/SolLightning-registry/pull/"+prNumber;
    }

    async isRegistering(): Promise<boolean> {
        const prNumberTxt = await fs.readFile(this.registryFile).catch(e => null);
        return prNumberTxt!=null;
    }

    async getRegistrationStatus(): Promise<{status: "pending" | "declined" | "approved", url: string}> {
        const prNumberTxt = await fs.readFile(this.registryFile).catch(e => null);
        const resp = await fetch("https://api.github.com/repos/adambor/SolLightning-registry/pulls/"+prNumberTxt);
        if(!resp.ok) throw new Error("Failed to fetch registration status from github: "+(await resp.text()));
        const obj = await resp.json();
        const state: "open" | "closed" = obj.state;
        const merged: boolean = obj.state;

        let status: "pending" | "declined" | "approved";
        if(state==="open") {
            status = "pending";
        } else {
            if(merged) {
                status = "approved";
            } else {
                status = "declined";
            }
        }

        return {
            status,
            url: "https://github.com/adambor/SolLightning-registry/pull/"+prNumberTxt
        }
    }

}