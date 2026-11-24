use anchor_lang::prelude::*;

use crate::state::EscrowTerms;

/// Full terms in the log: permanent in ledger history after the account closes.
#[event]
pub struct EscrowCreated {
    pub escrow: Pubkey,
    pub creator: Pubkey,
    pub terms: EscrowTerms,
}

#[event]
pub struct Deposited {
    pub escrow: Pubkey,
    pub from: Pubkey,
    pub credited: u64,
}

#[event]
pub struct Activated {
    pub escrow: Pubkey,
    pub at: i64,
}

#[event]
pub struct MilestoneChanged {
    pub escrow: Pubkey,
    pub index: u8,
    pub status: u8,
    pub outcome: u8,
}

#[event]
pub struct Voted {
    pub escrow: Pubkey,
    pub index: u8,
    pub seat: u8,
    pub vote: u8,
}

#[event]
pub struct MilestonePaid {
    pub escrow: Pubkey,
    pub index: u8,
    pub paid: u64,
    pub held: u64,
}

#[event]
pub struct StateChanged {
    pub escrow: Pubkey,
    pub state: u8,
    pub fault: u8,
}

#[event]
pub struct EscrowClosed {
    pub escrow: Pubkey,
    pub terms_hash: [u8; 32],
    pub state: u8,
    pub fault: u8,
    pub client_strike: bool,
    pub to_service: u64,
    pub to_client: u64,
    pub to_guarantors: u64,
    pub to_treasury: u64,
}
