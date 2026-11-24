//! Account and terms layouts. `EscrowTerms` must match packages/compiler/src/terms.ts byte for byte.

use anchor_lang::prelude::*;

use crate::errors::EscrowError;

pub const CONFIG_SEED: &[u8] = b"config";
pub const MINT_SEED: &[u8] = b"mint";
pub const ESCROW_SEED: &[u8] = b"escrow";

pub const TERMS_VERSION: u8 = 1;
pub const MAX_GUARANTORS: usize = 5;
pub const MAX_MILESTONES: usize = 8;
pub const MAX_CHECKS: usize = 6;

/// Program hard bounds. The compiler enforces the same numbers (compile.ts `HARD`).
pub const MAX_PROTOCOL_FEE_BPS: u16 = 200;
pub const MAX_GUARANTOR_FEE_BPS: u16 = 500;
pub const MIN_CRANK_TIP: u64 = 5_000;
pub const MAX_CRANK_TIP: u64 = 1_000_000;
pub const MIN_WINDOW: u32 = 3_600;
pub const BPS: u64 = 10_000;

// Release modes.
pub const RELEASE_DEADLINE: u8 = 0;
pub const RELEASE_CHECKS: u8 = 1;
pub const RELEASE_VOTE: u8 = 2;
pub const RELEASE_CHECKS_VOTE: u8 = 3;

// On-deadline-missed policy.
pub const ON_MISSED_SERVICE_FAULT: u8 = 0;
pub const ON_MISSED_RELEASE: u8 = 1;

// Check kinds.
pub const CHECK_MINT_AUTHORITY_REVOKED: u8 = 0;
pub const CHECK_FREEZE_AUTHORITY_REVOKED: u8 = 1;
pub const CHECK_MINT_SUPPLY: u8 = 2;

// Escrow states.
pub const STATE_FUNDING: u8 = 0;
pub const STATE_ACTIVE: u8 = 1;
pub const STATE_WARRANTY: u8 = 2;
pub const STATE_WARRANTY_DISPUTE: u8 = 3;
pub const STATE_FAULTED: u8 = 4;
pub const STATE_COMPLETED: u8 = 5;
pub const STATE_REFUNDED: u8 = 6;

// Milestone statuses.
pub const MS_PENDING: u8 = 0;
pub const MS_VOTING: u8 = 1;
pub const MS_CONTESTABLE: u8 = 2;
pub const MS_DISPUTED: u8 = 3;
pub const MS_PASSED: u8 = 4;
pub const MS_PAID: u8 = 5;
pub const MS_FAILED: u8 = 6;

// Votes and outcomes.
pub const VOTE_NONE: u8 = 0;
pub const VOTE_APPROVE: u8 = 1;
pub const VOTE_REJECT: u8 = 2;

// Fault and dispute markers.
pub const FAULT_NONE: u8 = 0;
pub const FAULT_SERVICE: u8 = 1;
pub const DISPUTE_NONE: u8 = 255;
pub const DISPUTE_WARRANTY: u8 = 254;
pub const BY_AUTO: u8 = 0;
pub const BY_SERVICE: u8 = 1;
pub const BY_CLIENT: u8 = 2;

// Mint gate flags recorded on MintAllow.
pub const FLAG_FREEZE_AUTHORITY: u8 = 1 << 0;
pub const FLAG_TRANSFER_FEE: u8 = 1 << 1;
pub const FLAG_PAUSABLE: u8 = 1 << 2;
pub const FLAG_TOKEN_2022: u8 = 1 << 3;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct CheckTerms {
    pub kind: u8,
    pub mint: Pubkey,
    pub value: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct MilestoneTerms {
    pub weight_bps: u16,
    /// Seconds after activation.
    pub deadline: u32,
    pub release: u8,
    pub on_missed: u8,
    pub checks: Vec<CheckTerms>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct EscrowTerms {
    pub version: u8,
    pub terms_hash: [u8; 32],
    pub settle_mint: Pubkey,
    pub decimals: u8,
    pub service: Pubkey,
    pub client: Pubkey,
    pub guarantors: Vec<Pubkey>,
    pub price: u64,
    pub service_bond: u64,
    pub client_bond: u64,
    pub guarantor_fee_bps: u16,
    pub service_fault_bps: u16,
    pub client_fault_bps: u16,
    pub warranty_hold_bps: u16,
    pub funding_window: u32,
    pub vote_window: u32,
    pub contest_window: u32,
    pub warranty_period: u32,
    pub crank_tip: u64,
    pub milestones: Vec<MilestoneTerms>,
}

impl EscrowTerms {
    pub fn serialized_len(&self) -> usize {
        // Fixed part + vectors. Kept explicit so space is computed without allocating.
        let fixed = 1 + 32 + 32 + 1 + 32 + 32 + 4 + 8 * 3 + 2 * 4 + 4 * 4 + 8 + 4;
        let ms: usize = self
            .milestones
            .iter()
            .map(|m| 2 + 4 + 1 + 1 + 4 + m.checks.len() * (1 + 32 + 8))
            .sum();
        fixed + self.guarantors.len() * 32 + ms
    }

    pub fn has_vote(&self) -> bool {
        self.milestones
            .iter()
            .any(|m| m.release == RELEASE_VOTE || m.release == RELEASE_CHECKS_VOTE)
    }

    /// Every rule the compiler enforces that the chain can check without the IR.
    pub fn validate(&self) -> std::result::Result<(), EscrowError> {
        use EscrowError::*;
        if self.version != TERMS_VERSION {
            return Err(UnsupportedVersion);
        }
        if self.service == self.client {
            return Err(SamePartyTwice);
        }
        if self.guarantors.len() > MAX_GUARANTORS {
            return Err(TooManyGuarantors);
        }
        for (i, g) in self.guarantors.iter().enumerate() {
            if *g == self.service || *g == self.client || self.guarantors[..i].contains(g) {
                return Err(SamePartyTwice);
            }
        }
        if self.price == 0 {
            return Err(ZeroPrice);
        }
        if self.guarantor_fee_bps > MAX_GUARANTOR_FEE_BPS
            || (self.guarantors.is_empty() && self.guarantor_fee_bps != 0)
        {
            return Err(BadRate);
        }
        for r in [self.service_fault_bps, self.client_fault_bps, self.warranty_hold_bps] {
            if r as u64 > BPS {
                return Err(BadRate);
            }
        }
        if self.crank_tip < MIN_CRANK_TIP || self.crank_tip > MAX_CRANK_TIP {
            return Err(BadCrankTip);
        }
        if self.funding_window < MIN_WINDOW || self.vote_window < MIN_WINDOW || self.contest_window < MIN_WINDOW {
            return Err(WindowTooShort);
        }
        if self.warranty_period == 0 && self.warranty_hold_bps != 0 {
            return Err(BadRate);
        }
        if self.milestones.is_empty() || self.milestones.len() > MAX_MILESTONES {
            return Err(BadMilestones);
        }
        let mut weight: u64 = 0;
        let mut checks = 0usize;
        for m in &self.milestones {
            if m.weight_bps == 0 || m.deadline == 0 {
                return Err(BadMilestones);
            }
            weight += m.weight_bps as u64;
            checks += m.checks.len();
            let uses_checks = m.release == RELEASE_CHECKS || m.release == RELEASE_CHECKS_VOTE;
            let uses_vote = m.release == RELEASE_VOTE || m.release == RELEASE_CHECKS_VOTE;
            if m.release > RELEASE_CHECKS_VOTE || m.on_missed > ON_MISSED_RELEASE {
                return Err(BadMilestones);
            }
            if uses_checks != !m.checks.is_empty() {
                return Err(BadChecks);
            }
            if uses_vote && self.guarantors.is_empty() {
                return Err(VoteWithoutGuarantors);
            }
            for c in &m.checks {
                if c.kind > CHECK_MINT_SUPPLY || (c.kind != CHECK_MINT_SUPPLY && c.value != 0) {
                    return Err(BadChecks);
                }
            }
        }
        if weight != BPS {
            return Err(WeightsNot100);
        }
        if checks > MAX_CHECKS {
            return Err(BadChecks);
        }
        Ok(())
    }
}

#[account]
pub struct Config {
    pub admin: Pubkey,
    /// v1 dispute resolver. Later versions replace this with the shark panel.
    pub arbiter: Pubkey,
    /// Wallet that owns the treasury token accounts.
    pub treasury: Pubkey,
    pub protocol_fee_bps: u16,
    pub bump: u8,
}

impl Config {
    pub const SPACE: usize = 8 + 32 * 3 + 2 + 1;
}

/// One record per mint that passed the mint gate.
#[account]
pub struct MintAllow {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub flags: u8,
    pub bump: u8,
}

impl MintAllow {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MilestoneState {
    pub status: u8,
    pub checks_passed: u8,
    pub votes: [u8; 5],
    pub outcome: u8,
    pub vote_deadline: i64,
    pub contest_deadline: i64,
}

impl MilestoneState {
    pub const SIZE: usize = 1 + 1 + 5 + 1 + 8 + 8;
}

#[account]
pub struct Escrow {
    pub bump: u8,
    pub creator: Pubkey,
    pub state: u8,
    pub fault: u8,
    pub client_strike: bool,
    pub dispute: u8,
    pub disputed_by: u8,
    /// Amounts credited to the vault (after any Token-2022 transfer fee).
    pub client_funded: u64,
    pub service_funded: u64,
    pub protocol_fee: u64,
    pub guarantor_fee: u64,
    pub created_at: i64,
    pub funding_deadline: i64,
    pub activated_at: i64,
    pub warranty_end: i64,
    /// Paid to the service so far.
    pub released: u64,
    /// Warranty holds kept back from milestone payouts.
    pub held: u64,
    /// Lamports above rent reserved for crank tips.
    pub tip_pool: u64,
    /// Seats whose every vote matched the final outcome / seats with any mismatch.
    pub seat_ok: u8,
    pub seat_bad: u8,
    pub milestones: Vec<MilestoneState>,
    pub terms: EscrowTerms,
}

impl Escrow {
    pub const FIXED: usize = 1 + 32 + 1 + 1 + 1 + 1 + 1 + 8 * 11 + 1 + 1;

    pub fn space(terms: &EscrowTerms) -> usize {
        8 + Self::FIXED + 4 + MilestoneState::SIZE * terms.milestones.len() + terms.serialized_len()
    }

    pub fn client_required(&self) -> u64 {
        self.terms.price + self.protocol_fee + self.guarantor_fee + self.terms.client_bond
    }

    pub fn fully_funded(&self) -> bool {
        self.client_funded >= self.client_required() && self.service_funded >= self.terms.service_bond
    }

    pub fn seat_of(&self, key: &Pubkey) -> Option<usize> {
        self.terms.guarantors.iter().position(|g| g == key)
    }

    /// Record whether each seat's vote on a milestone matched its final outcome.
    pub fn score_seats(&mut self, index: usize, final_vote: u8) {
        let votes = self.milestones[index].votes;
        for (seat, v) in votes.iter().enumerate().take(self.terms.guarantors.len()) {
            if *v == VOTE_NONE {
                continue;
            }
            if *v == final_vote {
                self.seat_ok |= 1 << seat;
            } else {
                self.seat_bad |= 1 << seat;
            }
        }
    }
}
