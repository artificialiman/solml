//! Mint gate: decides whether a mint can settle escrows, from its raw account data.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{
        default_account_state::DefaultAccountState, BaseStateWithExtensions, ExtensionType,
        StateWithExtensions,
    },
    state::{AccountState, Mint as MintState},
};
use anchor_lang::solana_program::program_pack::Pack;

use crate::errors::EscrowError;
use crate::state::{FLAG_FREEZE_AUTHORITY, FLAG_PAUSABLE, FLAG_TOKEN_2022, FLAG_TRANSFER_FEE};

pub struct GateResult {
    pub decimals: u8,
    pub flags: u8,
}

/// `owner` is the token program that owns the mint account.
pub fn gate(owner: &Pubkey, data: &[u8]) -> Result<GateResult> {
    if *owner == anchor_spl::token::ID {
        if data.len() != MintState::LEN {
            return err!(EscrowError::NotAMint);
        }
        let m = MintState::unpack(data).map_err(|_| error!(EscrowError::NotAMint))?;
        let mut flags = 0;
        if m.freeze_authority.is_some() {
            flags |= FLAG_FREEZE_AUTHORITY;
        }
        return Ok(GateResult { decimals: m.decimals, flags });
    }
    if *owner != spl_token_2022::ID {
        return err!(EscrowError::NotAMint);
    }
    let st = StateWithExtensions::<MintState>::unpack(data).map_err(|_| error!(EscrowError::NotAMint))?;
    let mut flags = FLAG_TOKEN_2022;
    if st.base.freeze_authority.is_some() {
        flags |= FLAG_FREEZE_AUTHORITY;
    }
    let types = st.get_extension_types().map_err(|_| error!(EscrowError::NotAMint))?;
    for t in types {
        match t {
            ExtensionType::PermanentDelegate => return err!(EscrowError::PermanentDelegate),
            ExtensionType::NonTransferable => return err!(EscrowError::NonTransferable),
            ExtensionType::TransferHook => return err!(EscrowError::TransferHook),
            ExtensionType::DefaultAccountState => {
                let ext = st
                    .get_extension::<DefaultAccountState>()
                    .map_err(|_| error!(EscrowError::NotAMint))?;
                if ext.state == AccountState::Frozen as u8 {
                    return err!(EscrowError::DefaultFrozen);
                }
            }
            ExtensionType::TransferFeeConfig => flags |= FLAG_TRANSFER_FEE,
            ExtensionType::Pausable => flags |= FLAG_PAUSABLE,
            _ => {}
        }
    }
    Ok(GateResult { decimals: st.base.decimals, flags })
}

/// Base mint fields for check evaluation. Works for SPL Token and Token-2022 mints.
pub fn read_mint(owner: &Pubkey, data: &[u8]) -> Result<MintState> {
    if *owner != anchor_spl::token::ID && *owner != spl_token_2022::ID {
        return err!(EscrowError::CheckAccountMismatch);
    }
    if data.len() < MintState::LEN {
        return err!(EscrowError::NotAMint);
    }
    MintState::unpack_from_slice(&data[..MintState::LEN]).map_err(|_| error!(EscrowError::NotAMint))
}
