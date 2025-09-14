import os
import time
from substrateinterface import SubstrateInterface, Keypair
from getpass import getpass

# --- Fixed configuration ---
CONFIG = {
    "polkadot": {
        "ws": "wss://rpc.polkadot.io",
        "token": "DOT",
        "seed": os.getenv("POLKADOT_PROXY_SEED"),
        "conviction": 1,
        "addresses": [
            "14zfiH2sMH955cG2yKUQbHSP3oQ8W4Ai9p9wSSZunvQ4TU4k",
            "16k5kPkBCMi89e1a9yGZGT4gHJW5H4KUQ5eVqPc8PGPxhi1K",
            "1ZXdGs6gFETHVTEW9RAZXwYxkDwAfE7wdt6czjBM4QRfMfk",
            "15B3UVXPRp3yS2gU7GogS41mwoT2fTL1KaNYPF7eMVjjWZJJ",
            "162tJdpDKWQZEwXEaNJKPSJiSyJtsv7wYGxYrreaTAXtvhK3",
            "13xa7rCYpABL4WvisHhzkwMtzKbEy8hoFDoXJU8efKqrCUPu"
        ],
        "amounts": [24300, 13300, 14800, 2500, 9300, 1400]  # DOT
    },
    "kusama": {
        "ws": "wss://kusama-rpc.polkadot.io",
        "token": "KSM",
        "seed": os.getenv("KUSAMA_PROXY_SEED"),
        "conviction": 1,
        "addresses": [
            "GHewg8AxLL7JpRYDoqEyTk5bhGndhMvsDWo68St7D9YDH9Z",
            "Dr9QwogB1x5BH91L4ebVnW2c8ZV9oQDfCRk4RUja5bTQjtH",
            "Dz4kkGBhj8Z73rLetfignvS1k9VJspphWgBU3SgyYbd7wZJ",
            "EfGRcmd9Ew1NeKc6uMNjJm9gZJL5s91RTk6y3Z7YjMVRRqP",
            "HNasn6AEovA12ub2zf4pXSy5pEqyYxb9KnrfbHDBW3Fo6qx",
            "G53juiSZ3SKPVMHaHqxKsESgvJeKxn5RkcAFHaUHey3fcJB",
            "GLXvtF6k8UZ4eiohpCG537J6hLGuRidENNyWk9HMeC6a4P5"
        ],
        "amounts": [50, 50, 300, 300, 250, 200, 200]  # KSM
    }
}


# --- Helpers ---
def ask(q):
    return input(q).strip()


def default_voting(substrate, cfg, proxy_kp):
    referendum = ask("Enter referendum index: ")
    vote_side = ask("Vote type (aye/nay): ").lower()
    is_aye = vote_side == "aye"

    print("\n📋 Voting Plan:")
    for addr, amount in zip(cfg["addresses"], cfg["amounts"]):
        print(f"- {addr}: {'AYE' if is_aye else 'NAY'}, {amount} {cfg['token']}, conviction {cfg['conviction']}x")

    confirm = ask("Do you confirm broadcasting these votes? (y/n): ")
    if confirm.lower() != "y":
        print("❌ Cancelled.")
        return

    for addr, amount in zip(cfg["addresses"], cfg["amounts"]):
        balance_plancks = amount * 10**12
        print(f"\nVoting {'AYE' if is_aye else 'NAY'} on referendum {referendum} for {addr}")
        print(f"Locking {amount} {cfg['token']} with conviction {cfg['conviction']}x")

        try:
            call = substrate.compose_call(
                call_module="ConvictionVoting",
                call_function="vote",
                call_params={
                    "poll_index": int(referendum),
                    "vote": {
                        "Standard": {
                            "vote": {"aye": is_aye, "conviction": f"Locked{cfg['conviction']}x"},
                            "balance": balance_plancks,
                        }
                    },
                },
            )
        except Exception:
            # fallback democracy.vote
            call = substrate.compose_call(
                call_module="Democracy",
                call_function="vote",
                call_params={
                    "ref_index": int(referendum),
                    "vote": {"aye": is_aye, "conviction": f"Locked{cfg['conviction']}x"},
                },
            )

        proxy_call = substrate.compose_call(
            call_module="Proxy",
            call_function="proxy",
            call_params={
                "real": addr,
                "force_proxy_type": "Governance",
                "call": call,
            },
        )

        extrinsic = substrate.create_signed_extrinsic(call=proxy_call, keypair=proxy_kp)
        receipt = substrate.submit_extrinsic(extrinsic, wait_for_inclusion=True)
        print(f"✅ Included in block {receipt.block_hash}")
        time.sleep(5)

    print("\n✅ All default votes submitted.")


def custom_voting(substrate, proxy_kp, token):
    referendums = [r.strip() for r in ask("Enter referendum indexes (comma-separated): ").split(",")]
    vote_types = {}
    convictions = {}

    for r in referendums:
        vt = ask(f"Vote type for referendum {r} (aye/nay): ").lower()
        cv = int(ask(f"Conviction multiplier for referendum {r} (1-6): "))
        vote_types[r] = vt
        convictions[r] = cv

    all_votes = []

    while True:
        proxied = ask("Enter proxied account address: ")
        token_amounts = {}
        same_amount = ask(f"Use same {token} amount for all referendums? (y/n): ").lower()

        if same_amount == "y":
            amt = int(ask(f"Enter {token} amount for all referendums: "))
            for r in referendums:
                token_amounts[r] = amt
        else:
            for r in referendums:
                token_amounts[r] = int(ask(f"Amount of {token} to lock for referendum {r}: "))

        all_votes.append((proxied, token_amounts))

        more = ask("Add another proxied account? (y/n): ")
        if more != "y":
            break

    print("\n📋 Review votes:")
    for proxied, token_amounts in all_votes:
        print(f"\nProxied: {proxied}")
        for r in referendums:
            print(f"- Referendum {r}: {vote_types[r].upper()}, {token_amounts[r]} {token}, conviction {convictions[r]}x")

    confirm = ask("Confirm broadcasting? (y/n): ")
    if confirm != "y":
        print("❌ Cancelled.")
        return

    for proxied, token_amounts in all_votes:
        for r in referendums:
            balance_plancks = token_amounts[r] * 10**12
            is_aye = vote_types[r] == "aye"
            print(f"\nVoting {vote_types[r].upper()} on referendum {r} for {proxied}")
            print(f"Locking {token_amounts[r]} {token} with conviction {convictions[r]}x")

            try:
                call = substrate.compose_call(
                    call_module="ConvictionVoting",
                    call_function="vote",
                    call_params={
                        "poll_index": int(r),
                        "vote": {
                            "Standard": {
                                "vote": {"aye": is_aye, "conviction": f"Locked{convictions[r]}x"},
                                "balance": balance_plancks,
                            }
                        },
                    },
                )
            except Exception:
                call = substrate.compose_call(
                    call_module="Democracy",
                    call_function="vote",
                    call_params={
                        "ref_index": int(r),
                        "vote": {"aye": is_aye, "conviction": f"Locked{convictions[r]}x"},
                    },
                )

            proxy_call = substrate.compose_call(
                call_module="Proxy",
                call_function="proxy",
                call_params={
                    "real": proxied,
                    "force_proxy_type": "Governance",
                    "call": call,
                },
            )

            extrinsic = substrate.create_signed_extrinsic(call=proxy_call, keypair=proxy_kp)
            receipt = substrate.submit_extrinsic(extrinsic, wait_for_inclusion=True)
            print(f"✅ Included in block {receipt.block_hash}")
            time.sleep(5)

    print("✅ All custom votes submitted.")


def main():
    use_default = ask("Use default (pre-set addresses/amounts)? (y/n): ").lower() == "y"
    network = ask("Select network (polkadot/kusama): ").lower()
    cfg = CONFIG.get(network)

    if not cfg:
        print("❌ Invalid network")
        return

    if not cfg["seed"]:
        cfg["seed"] = getpass(f"Enter seed for {network} proxy account: ")

    substrate = SubstrateInterface(url=cfg["ws"])
    proxy_kp = Keypair.create_from_mnemonic(cfg["seed"])
    print(f"✅ Using Proxy Account: {proxy_kp.ss58_address} on {network.upper()}")

    if use_default:
        default_voting(substrate, cfg, proxy_kp)
    else:
        custom_voting(substrate, proxy_kp, cfg["token"])


if __name__ == "__main__":
    main()
