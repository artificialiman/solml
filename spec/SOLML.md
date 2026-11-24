# SolML 1 — Language Reference

SolML is the markup half of a contract. It states parties, money, milestones and checks. It holds no conditionals, loops or formulas. Constraints and failure policy live in SSS ([SSS.md](SSS.md)); state transitions live in the program ([PROGRAM.md](PROGRAM.md)).

## 1. Document rules

| Rule | Value |
| --- | --- |
| Syntax | Strict XML subset: elements, quoted attributes, self-closing tags, text, `<!-- -->` comments |
| Not allowed | Processing instructions, CDATA, DOCTYPE, namespaces, unknown entities |
| Entities | `&amp;` `&lt;` `&gt;` `&quot;` `&apos;` |
| Root element | `<escrow>` or `<hold>` |
| Unknown element or attribute | Compile error |
| Whitespace and attribute order | Ignored; they never change the terms hash |

### Grammar (EBNF)

```
document   = misc* element misc* ;
element    = "<" name attr* ( "/>" | ">" content* "</" name ">" ) ;
attr       = name "=" ( '"' text '"' | "'" text "'" ) ;
content    = element | text | comment ;
misc       = whitespace | comment ;
name       = letter ( letter | digit | "_" | "-" )* ;
```

## 2. Value types

Every value is converted to an integer before it reaches the IR.

| Type | Form | Result | Example |
| --- | --- | --- | --- |
| key | base58, 32 bytes | public key | `9pLm...2Qe` |
| duration | integer + `s` `m` `h` `d` `w` | seconds (u32) | `72h` → 259,200 |
| rate | `N%` (≤ 2 decimals) or `Nbps` | basis points, 0–10,000 | `2.5%` → 250 |
| amount | decimal, optional symbol | base units (u64) | `1.5 SOL` → 1,500,000,000 |
| slug | `[a-z0-9][a-z0-9-]{0,31}` | string | `launch-0042` |

An amount with more decimal places than the settlement mint allows is an error, not a rounding.

## 3. Elements

### `<escrow>` (root)

| Attribute | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Slug. Part of the terms hash, so it separates otherwise identical contracts |
| `settle` | yes | `SOL`, `USDC`, or `mint:<key>` |
| `decimals` | for `mint:` only | 0–18. Forbidden for `SOL`/`USDC` |
| `symbol` | no | 1–10 characters, for `mint:`; default `TOKEN` |
| `cluster` | no | `mainnet` (default) or `devnet`; selects the USDC mint |
| `version` | no | `1` |

Known mints:

| Symbol | mainnet | devnet | Decimals |
| --- | --- | --- | --- |
| SOL (wrapped) | `So11111111111111111111111111111111111111112` | same | 9 |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | 6 |

### Children of `<escrow>`

| Element | Count | Attributes | Meaning |
| --- | --- | --- | --- |
| `<meta name="guarantor" content="wallet:<key>">` | 0–5 | | One guarantor seat. `dex:<name>` and `sharks` are reserved for later program versions |
| `<meta name="title" content="...">` | 0–1 | | ≤ 120 characters; stored in the IR, not on chain |
| `<service wallet>` | 1 | `wallet` key | Performs the work; receives payouts |
| `<client wallet>` | 1 | `wallet` key | Pays the price |
| `<deposit from="client" amount>` | 1 | `amount` | The price. Must be above zero |
| `<bond from percent>` | 0–1 per side | `from` = `service`/`client`, `percent` rate | Collateral as a share of price. Absent → SSS default |
| `<deliverable>` | 0–n | text | Plain-language deliverable; committed by the terms hash |
| `<milestone>` | 1–8 | see below | A tranche of the price |
| `<warranty period hold>` | 0–1 | duration, rate | Share of each payout held until the period ends |
| `<receipt format="cnft" soulbound="true">` | 0–1 | | Receipt form; the only accepted values in v1 |

The service, client and every guarantor must be different wallets.

### `<milestone>`

| Attribute | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Slug, unique in the contract |
| `weight` | yes | Rate above 0. All weights sum to exactly 100% |
| `deadline` | yes | Duration after activation (both deposits in). Above 0 |
| `release` | no | `deadline`, `checks`, `vote`, `checks+vote`. Default: `checks` if the milestone has `<check>` children, else `vote` |

| Release | Passes when |
| --- | --- |
| `deadline` | The deadline passes and anyone cranks |
| `checks` | Every `<check>` reads true on chain |
| `vote` | ⌈2N/3⌉ of N guarantor seats approve, and the contest window closes uncontested |
| `checks+vote` | Checks pass, then the vote as above |

### `<check>` (inside `<milestone>`)

Exactly one predicate per check, plus `mint`. At most 6 checks per contract.

| Predicate | Passes when |
| --- | --- |
| `mint-authority="revoked"` | The mint's mint authority is empty |
| `freeze-authority="revoked"` | The mint's freeze authority is empty |
| `mint-supply="N"` | Supply equals N base units of that mint |

Reserved, rejected by the v1 compiler: `pool`, `lp`, `min-liquidity`, `distributor`, `root`, `vesting`.

## 4. `<hold>` shorthand

A timed transfer: the client's amount is released to `to` after `duration`.

```html
<hold id="pay-dev-0001" settle="mint:<key>" decimals="6" symbol="GUIDING"
      from="<client key>" to="<service key>" amount="250000 GUIDING" duration="7d" />
```

Expands to one `<escrow>` with one `release="deadline"` milestone of weight 100% and both bonds at 0%. `<hold>` accepts only `<meta>`, `<deliverable>` and `<receipt>` children.

## 5. Diagnostics

Errors print as `file:line:col CODE: message`, plus `(rule at file:line:col)` when an SSS rule set the limit that was broken.

| Code | Meaning |
| --- | --- |
| `E_MARKUP` `E_DUP_ATTR` | Syntax |
| `E_ROOT` `E_CHILD` `E_ATTR` `E_TEXT` `E_COUNT` `E_REQUIRED` | Structure |
| `E_KEY` `E_AMOUNT` `E_RATE` `E_DURATION` `E_DECIMALS` `E_SYMBOL` `E_ID` | Values |
| `E_SETTLE` `E_CLUSTER` `E_VERSION` | Settlement and version |
| `E_PARTIES` `E_SEAT` `E_SEAT_INACTIVE` `E_META` `E_TITLE` | Parties and seats |
| `E_RELEASE` `E_WEIGHTS` `E_CHECK` `E_CHECK_RESERVED` `E_BOND` `E_DEPOSIT` `E_RECEIPT` | Milestones and money |
| `E_CONSTRAINT` | An SSS `min-*`/`max-*` limit was broken |
| `E_BOUND` | A program hard bound was broken (SSS cannot loosen these) |
| `E_TERMS_SIZE` | Compact terms exceed 760 bytes |
| `E_SSS_SYNTAX` `E_SSS_SELECTOR` `E_SSS_PROPERTY` `E_SSS_VALUE` | Style sheet errors |
