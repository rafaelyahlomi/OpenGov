require('dotenv').config();
const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const readline = require('readline');

// Set up readline interface for interactive input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const NETWORKS = {
    polkadot: { ws: "wss://rpc.polkadot.io", token: "DOT", seed: process.env.POLKADOT_PROXY_SEED },
    kusama: { ws: "wss://kusama-rpc.polkadot.io", token: "KSM", seed: process.env.KUSAMA_PROXY_SEED }
};

async function askQuestion(question) {
    return new Promise(resolve => rl.question(question, resolve));
}

async function getValidatedInput(question, validateFn) {
    let input;
    while (true) {
        input = await askQuestion(question);
        if (validateFn(input)) break;
        console.log("❌ Invalid input. Please try again.");
    }
    return input;
}

async function main() {
    const networkChoice = await getValidatedInput("Select network (polkadot/kusama): ", input => ["polkadot", "kusama"].includes(input.toLowerCase()));
    const selectedNetwork = NETWORKS[networkChoice];
    
    const wsProvider = new WsProvider(selectedNetwork.ws);
    const api = await ApiPromise.create({ provider: wsProvider });
    const keyring = new Keyring({ type: 'sr25519' });
    const proxyAccount = keyring.addFromUri(selectedNetwork.seed);
    
    console.log(`Using Proxy Account: ${proxyAccount.address} on ${networkChoice.toUpperCase()}`);

    let referendums;
    let firstProxiedAccount = true;
    const allVotes = [];
    
    while (true) {
        const proxiedAccount = await askQuestion("Enter the proxied account address: ");
        console.log(`Voting on behalf of: ${proxiedAccount}`);
        
        if (!firstProxiedAccount) {
            const reuseReferendums = await askQuestion("Do you want to reuse the same referendums from the previous proxied account? (y/n): ");
            if (reuseReferendums.toLowerCase() !== 'y') {
                const referendumsInput = await askQuestion("Enter referendum indexes (comma-separated): ");
                referendums = referendumsInput.split(',').map(r => r.trim());
            }
        } else {
            const referendumsInput = await askQuestion("Enter referendum indexes (comma-separated): ");
            referendums = referendumsInput.split(',').map(r => r.trim());
            firstProxiedAccount = false;
        }
        
        const voteTypes = {};
        for (const referendum of referendums) {
            voteTypes[referendum] = await getValidatedInput(
                `Vote type for referendum ${referendum} (aye/nay): `,
                input => ["aye", "nay"].includes(input.toLowerCase())
            );
        }

        const convictions = {};
        for (const referendum of referendums) {
            convictions[referendum] = await getValidatedInput(
                `Conviction multiplier for referendum ${referendum} (1-6): `,
                input => !isNaN(input) && parseInt(input) >= 1 && parseInt(input) <= 6
            );
        }

        const useSameAmount = await askQuestion(`Do you want to use the same amount of ${selectedNetwork.token} for all referendums? (y/n): `);
        let dotAmounts = {};
        if (useSameAmount.toLowerCase() === 'y') {
            const amount = await getValidatedInput(`Enter ${selectedNetwork.token} amount to lock for all referendums: `, input => !isNaN(input) && Number(input) > 0);
            referendums.forEach(referendum => dotAmounts[referendum] = amount);
        } else {
            for (const referendum of referendums) {
                dotAmounts[referendum] = await getValidatedInput(
                    `Amount of ${selectedNetwork.token} to lock for referendum ${referendum}: `,
                    input => !isNaN(input) && Number(input) > 0
                );
            }
        }

        allVotes.push({ proxiedAccount, referendums, voteTypes, convictions, dotAmounts });

        const addAnother = await askQuestion("Do you want to add another proxied account? (y/n): ");
        if (addAnother.toLowerCase() !== 'y') break;
    }

    console.log("\nReview your votes before submission:");
    allVotes.forEach(({ proxiedAccount, referendums, voteTypes, convictions, dotAmounts }, i) => {
        console.log(`\n[${i + 1}] Proxied Account: ${proxiedAccount}`);
        referendums.forEach(referendum => {
            console.log(
                `  Referendum ${referendum}: ${voteTypes[referendum].toUpperCase()}, ` +
                `${dotAmounts[referendum]} ${selectedNetwork.token}, Conviction ${convictions[referendum]}x`
            );
        });
    });

    const confirmation = await askQuestion("Do you confirm broadcasting these votes? (y/n): ");
    if (confirmation.toLowerCase() !== 'y') {
        console.log("❌ Transaction cancelled.");
        rl.close();
        process.exit(0);
    }

    console.log("\nStarting voting process...");
    for (const { proxiedAccount, referendums, voteTypes, convictions, dotAmounts } of allVotes) {
        for (const referendum of referendums) {
            console.log(`\nVoting ${voteTypes[referendum].toUpperCase()} on referendum ${referendum} for ${proxiedAccount}`);
            console.log(`Locking ${dotAmounts[referendum]} ${selectedNetwork.token} with conviction ${convictions[referendum]}x`);

            const balancePlancks = BigInt(dotAmounts[referendum]) * BigInt(10 ** 10);
            let voteTx;

            if (api.tx.democracy?.vote) {
                voteTx = api.tx.democracy.vote(referendum, { aye: voteTypes[referendum] === 'aye', conviction: `Locked${convictions[referendum]}x` });
            } else if (api.tx.convictionVoting?.vote) {
                voteTx = api.tx.convictionVoting.vote(referendum, { Standard: { vote: { aye: voteTypes[referendum] === 'aye', conviction: `Locked${convictions[referendum]}x` }, balance: balancePlancks } });
            } else {
                console.error("❌ Voting method not found in the API.");
                continue;
            }

            const proxyVote = api.tx.proxy.proxy(proxiedAccount, 'Governance', voteTx);
            await new Promise(resolve => {
                proxyVote.signAndSend(proxyAccount, ({ status }) => {
                    console.log(`Transaction status: ${status.type}`);
                    if (status.isFinalized) {
                        console.log(`✅ Finalized in block: ${status.asFinalized}`);
                        resolve();
                    }
                });
            });

            console.log("⏳ Waiting 10 seconds before next vote...");
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }

    console.log("✅ All votes submitted.");
    rl.close();
}

main().catch(error => {
    console.error("❌ Error occurred:", error);
    rl.close();
});
