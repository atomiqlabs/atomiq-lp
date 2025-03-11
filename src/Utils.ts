
export function fromDecimal(amount: string, decimalCount: number): bigint {

    if(amount.includes(".")) {
        const [before, after] = amount.split(".");
        if(decimalCount<0) {
            return BigInt(before.substring(0, before.length+decimalCount));
        }
        if(after.length>decimalCount) {
            //Cut the last digits
            return BigInt((before==="0" ? "" : before)+after.substring(0, decimalCount));
        }
        return BigInt((before==="0" ? "" : before)+after.padEnd(decimalCount, "0"));
    } else {
        if(decimalCount<0) {
            return BigInt(amount.substring(0, amount.length+decimalCount));
        } else {
            return BigInt(amount+"0".repeat(decimalCount));
        }
    }

}

export function toDecimal(amount: bigint, decimalCount: number, cut?: boolean) {
    if(decimalCount<=0) {
        return amount.toString(10)+"0".repeat(-decimalCount);
    }

    const amountStr = amount.toString(10).padStart(decimalCount+1, "0");

    const splitPoint = amountStr.length-decimalCount;

    const decimalPart = amountStr.substring(splitPoint, amountStr.length);
    let cutTo = decimalPart.length;
    if(cut && cutTo>0) {
        for(let i=decimalPart.length-1;i--;i>=0) {
            if(decimalPart.charAt(i)==="0") {
                cutTo = i;
            } else break;
        }
        if(cutTo===0) cutTo = 1;
    }

    return amountStr.substring(0, splitPoint)+"."+decimalPart.substring(0, cutTo);
}
