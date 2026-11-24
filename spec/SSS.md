# SSS 1 — SolML Style Sheets

SSS sets defaults, constraints and failure policy for SolML elements. It never moves money and holds no conditionals. Every SSS value resolves at compile time; the program receives only the results.

## 1. Syntax

A CSS subset.

```css
/* comment */
selector, selector { property: value; property: value; }
```

| Allowed | Not allowed |
| --- | --- |
| `*`, `type`, `type[attr=value]`, chained attribute selectors, comma lists | Combinators, pseudo-classes, at-rules, `!important`, functions |

## 2. Cascade

For each element and property, the winning declaration is chosen in this order:

1. **Origin**: base sheet < `<hold>` sheet < contract sheets.
2. **Specificity**: `*` = 0, a type = 1, each `[attr=value]` = +10.
3. **Source order**: later wins. Contract sheets are read in the order given.

Elements with no SolML tag are styled through virtual elements: `vote` always exists; `bond[from=service]` and `bond[from=client]` exist even when the contract has no `<bond>`.

## 3. Properties

| Selector | Property | Type | Base value | Role |
| --- | --- | --- | --- | --- |
| `escrow` | `funding-window` | duration | 7d | Default |
| `escrow` | `max-duration` | duration | 365d | Constraint: last deadline + warranty |
| `escrow` | `guarantor-fee` | rate | 100bps | Default |
| `escrow` | `crank-tip` | lamports | 20000 | Default |
| `escrow` | `on-underfund` | `refund-all` | refund-all | Policy |
| `bond` | `default` | rate | service 20%, client 5% | Default when `<bond>` has no `percent` |
| `bond` | `min` / `max` | rate | service 10–100%, client 0–20% | Constraint |
| `bond` | `fault-share` | rate | 50% | Share of that bond paid to the other side on fault |
| `milestone` | `on-deadline-missed` | `service-fault` \| `release` | service-fault | Policy for `checks` and `checks+vote` milestones |
| `milestone` | `min-deadline` / `max-deadline` | duration | 1h / 365d | Constraint |
| `vote` | `window` | duration | 72h | Default |
| `vote` | `contest-window` | duration | 48h | Default |
| `warranty` | `max-period` | duration | 180d | Constraint |
| `warranty` | `max-hold` | rate | 30% | Constraint |
| `warranty` | `on-no-claim` | `release-hold` | release-hold | Policy |

## 4. Hard bounds

The program enforces these numbers. A sheet that crosses them fails compilation with `E_BOUND`.

| Bound | Value |
| --- | --- |
| Guarantor fee | ≤ 500 bps |
| Crank tip | 5,000 – 1,000,000 lamports |
| Funding, vote and contest windows | ≥ 1 hour |
| Milestone deadline | > 0 |
| Protocol fee (program config, not SSS) | ≤ 200 bps |

## 5. Base sheet

```css
escrow {
  funding-window: 7d;
  max-duration: 365d;
  guarantor-fee: 100bps;
  crank-tip: 20000;
  on-underfund: refund-all;
}
bond[from=service] { default: 20%; min: 10%; max: 100%; fault-share: 50%; }
bond[from=client]  { default: 5%;  min: 0%;  max: 20%;  fault-share: 50%; }
milestone {
  on-deadline-missed: service-fault;
  min-deadline: 1h;
  max-deadline: 365d;
}
vote { window: 72h; contest-window: 48h; }
warranty { max-period: 180d; max-hold: 30%; on-no-claim: release-hold; }
```

`<hold>` adds, above the base sheet:

```css
bond { default: 0%; min: 0%; }
```

## 6. Example

```css
vote { window: 48h; }
bond[from=service] { fault-share: 75%; }
milestone[id=airdrop] { on-deadline-missed: release; }
```

The third rule beats the base `milestone` rule on origin, and would beat a contract-level `milestone` rule on specificity.
