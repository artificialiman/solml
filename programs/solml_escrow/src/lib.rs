//! SolML v1 escrow program.
//!
//! One audited program holds every escrow. A SolML contract compiles to `EscrowTerms`;
//! the escrow's address is derived from the contract's terms hash, so a contract file
//! determines exactly one escrow account.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

pub mod errors;
pub mod events;
pub mod gate;
pub mod math;
pub mod state;

use errors::EscrowError;
use events::*;
use math::{milestone_amount, settle, vote_threshold, Outcome, SettleIn};
use state::*;

declare_id!("3bNY3MoiTTYZMCg3imcHF1UKGuNJ8M2186uSSvMd8SKV");

/// Crank index that targets the escrow itself rather than a milestone.
pub const ESCROW_LEVEL: u8 = 255;

#[program]
pub mod solml_escrow {
    use super::*;

    /// One-time setup, signed by the program's upgrade authority.
    pub fn init_config(
        ctx: Context<InitConfig>,
        arbiter: Pubkey,
        treasury: Pubkey,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        require!(protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS, EscrowError::ProtocolFeeTooHigh);
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.arbiter = arbiter;
        c.treasury = treasury;
        c.protocol_fee_bps = protocol_fee_bps;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_config(
        ctx: Context<SetConfig>,
        admin: Pubkey,
        arbiter: Pubkey,
        treasury: Pubkey,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        require!(protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS, EscrowError::ProtocolFeeTooHigh);
        let c = &mut ctx.accounts.config;
        c.admin = admin;
        c.arbiter = arbiter;
        c.treasury = treasury;
        c.protocol_fee_bps = protocol_fee_bps;
        Ok(())
    }

    /// Runs the mint gate and records the mint as allowed for settlement.
    pub fn allow_mint(ctx: Context<AllowMint>) -> Result<()> {
        let info = ctx.accounts.mint.to_account_info();
        let res = gate::gate(info.owner, &info.try_borrow_data()?)?;
        let a = &mut ctx.accounts.mint_allow;
        a.mint = info.key();
        a.token_program = *info.owner;
        a.decimals = res.decimals;
        a.flags = res.flags;
        a.bump = ctx.bumps.mint_allow;
        Ok(())
    }

    pub fn create_escrow(ctx: Context<CreateEscrow>, terms: EscrowTerms) -> Result<()> {
        terms.validate()?;
        require!(ctx.accounts.mint.decimals == terms.decimals, EscrowError::DecimalsMismatch);
        require_keys_eq!(
            ctx.accounts.mint_allow.token_program,
            ctx.accounts.token_program.key(),
            EscrowError::MintNotAllowed
        );
        let now = Clock::get()?.unix_timestamp;
        let tip_slots = 3 * terms.milestones.len() as u64 + 2;
        let tip_pool = terms.crank_tip.checked_mul(tip_slots).ok_or(EscrowError::Overflow)?;
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            tip_pool,
        )?;

        let e = &mut ctx.accounts.escrow;
        e.bump = ctx.bumps.escrow;
        e.creator = ctx.accounts.creator.key();
        e.state = STATE_FUNDING;
        e.fault = FAULT_NONE;
        e.client_strike = false;
        e.dispute = DISPUTE_NONE;
        e.disputed_by = BY_AUTO;
        e.client_funded = 0;
        e.service_funded = 0;
        e.protocol_fee = math::bps_floor(terms.price, ctx.accounts.config.protocol_fee_bps);
        e.guarantor_fee = math::bps_floor(terms.price, terms.guarantor_fee_bps);
        e.created_at = now;
        e.funding_deadline = now + terms.funding_window as i64;
        e.activated_at = 0;
        e.warranty_end = 0;
        e.released = 0;
        e.held = 0;
        e.tip_pool = tip_pool;
        e.seat_ok = 0;
        e.seat_bad = 0;
        e.milestones = vec![MilestoneState::default(); terms.milestones.len()];
        e.terms = terms.clone();

        emit!(EscrowCreated { escrow: e.key(), creator: e.creator, terms });
        Ok(())
    }

    /// Client deposits price + fees + client bond; service deposits its bond.
    /// `amount` is what leaves the depositor; the vault credit must cover the requirement.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let e = &ctx.accounts.escrow;
        require!(e.state == STATE_FUNDING, EscrowError::WrongState);
        require!(now < e.funding_deadline, EscrowError::FundingClosed);
        let who = ctx.accounts.depositor.key();
        let is_client = who == e.terms.client;
        require!(is_client || who == e.terms.service, EscrowError::NotAParty);
        let required = if is_client { e.client_required() } else { e.terms.service_bond };
        let already = if is_client { e.client_funded } else { e.service_funded };
        require!(already == 0 && required > 0, EscrowError::AlreadyFunded);

        let before = ctx.accounts.vault.amount;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.vault.reload()?;
        let credited = ctx.accounts.vault.amount.checked_sub(before).ok_or(EscrowError::Overflow)?;
        require!(credited >= required, EscrowError::Underfunded);

        let key = ctx.accounts.escrow.key();
        let e = &mut ctx.accounts.escrow;
        if is_client {
            e.client_funded = credited;
        } else {
            e.service_funded = credited;
        }
        emit!(Deposited { escrow: key, from: who, credited });
        if e.fully_funded() {
            e.state = STATE_ACTIVE;
            e.activated_at = now;
            emit!(Activated { escrow: key, at: now });
        }
        Ok(())
    }

    /// Reads check mints (remaining accounts, in check order) and records passed checks.
    pub fn verify(ctx: Context<Act>, index: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let key = ctx.accounts.escrow.key();
        let e = &mut ctx.accounts.escrow;
        require!(e.state == STATE_ACTIVE, EscrowError::WrongState);
        let i = index as usize;
        require!(i < e.milestones.len(), EscrowError::BadIndex);
        let mt = e.terms.milestones[i].clone();
        require!(
            mt.release == RELEASE_CHECKS || mt.release == RELEASE_CHECKS_VOTE,
            EscrowError::WrongMilestoneStatus
        );
        require!(e.milestones[i].status == MS_PENDING, EscrowError::WrongMilestoneStatus);
        require!(ctx.remaining_accounts.len() == mt.checks.len(), EscrowError::CheckAccountMismatch);

        let mut bits = e.milestones[i].checks_passed;
        for (j, (c, acc)) in mt.checks.iter().zip(ctx.remaining_accounts.iter()).enumerate() {
            require_keys_eq!(acc.key(), c.mint, EscrowError::CheckAccountMismatch);
            let m = gate::read_mint(acc.owner, &acc.try_borrow_data()?)?;
            require!(m.is_initialized, EscrowError::NotAMint);
            let pass = match c.kind {
                CHECK_MINT_AUTHORITY_REVOKED => m.mint_authority.is_none(),
                CHECK_FREEZE_AUTHORITY_REVOKED => m.freeze_authority.is_none(),
                CHECK_MINT_SUPPLY => m.supply == c.value,
                _ => false,
            };
            if pass {
                bits |= 1 << j;
            }
        }
        e.milestones[i].checks_passed = bits;
        let all = (1u16 << mt.checks.len()) - 1;
        if bits as u16 == all {
            if mt.release == RELEASE_CHECKS {
                e.milestones[i].status = MS_PASSED;
            } else {
                e.milestones[i].status = MS_VOTING;
                e.milestones[i].vote_deadline = now + e.terms.vote_window as i64;
            }
            let st = e.milestones[i];
            emit!(MilestoneChanged { escrow: key, index, status: st.status, outcome: st.outcome });
            pay_tip(e, &ctx.accounts.caller)?;
        }
        Ok(())
    }

    pub fn vote(ctx: Context<Act>, index: u8, approve: bool) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let key = ctx.accounts.escrow.key();
        let e = &mut ctx.accounts.escrow;
        require!(e.state == STATE_ACTIVE, EscrowError::WrongState);
        let i = index as usize;
        require!(i < e.milestones.len(), EscrowError::BadIndex);
        let seat = e.seat_of(&ctx.accounts.caller.key()).ok_or(EscrowError::NotAGuarantor)?;
        let release = e.terms.milestones[i].release;
        match e.milestones[i].status {
            MS_PENDING if release == RELEASE_VOTE => {
                e.milestones[i].status = MS_VOTING;
                e.milestones[i].vote_deadline = now + e.terms.vote_window as i64;
            }
            MS_PENDING if release == RELEASE_CHECKS_VOTE => return err!(EscrowError::ChecksFirst),
            MS_VOTING => {}
            _ => return err!(EscrowError::WrongMilestoneStatus),
        }
        require!(now < e.milestones[i].vote_deadline, EscrowError::TooLate);
        require!(e.milestones[i].votes[seat] == VOTE_NONE, EscrowError::AlreadyVoted);
        let v = if approve { VOTE_APPROVE } else { VOTE_REJECT };
        e.milestones[i].votes[seat] = v;
        emit!(Voted { escrow: key, index, seat: seat as u8, vote: v });

        let t = vote_threshold(e.terms.guarantors.len());
        let votes = e.milestones[i].votes;
        let approvals = votes.iter().filter(|x| **x == VOTE_APPROVE).count();
        let rejects = votes.iter().filter(|x| **x == VOTE_REJECT).count();
        let outcome = if approvals >= t {
            VOTE_APPROVE
        } else if rejects >= t {
            VOTE_REJECT
        } else {
            VOTE_NONE
        };
        if outcome != VOTE_NONE {
            let contest_window = e.terms.contest_window as i64;
            let ms = &mut e.milestones[i];
            ms.status = MS_CONTESTABLE;
            ms.outcome = outcome;
            ms.contest_deadline = now + contest_window;
            emit!(MilestoneChanged { escrow: key, index, status: MS_CONTESTABLE, outcome });
        }
        Ok(())
    }

    /// The losing side of a vote moves the milestone to dispute inside the contest window.
    pub fn contest(ctx: Context<Act>, index: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let key = ctx.accounts.escrow.key();
        let e = &mut ctx.accounts.escrow;
        require!(e.state == STATE_ACTIVE, EscrowError::WrongState);
        let i = index as usize;
        require!(i < e.milestones.len(), EscrowError::BadIndex);
        require!(e.milestones[i].status == MS_CONTESTABLE, EscrowError::WrongMilestoneStatus);
        require!(now < e.milestones[i].contest_deadline, EscrowError::TooLate);
        require!(e.dispute == DISPUTE_NONE, EscrowError::DisputeOpen);
        let who = ctx.accounts.caller.key();
        let by = match e.milestones[i].outcome {
            VOTE_APPROVE if who == e.terms.client => BY_CLIENT,
            VOTE_REJECT if who == e.terms.service => BY_SERVICE,
            _ => return err!(EscrowError::CannotContest),
        };
        e.milestones[i].status = MS_DISPUTED;
        e.dispute = index;
        e.disputed_by = by;
        let outcome = e.milestones[i].outcome;
        emit!(MilestoneChanged { escrow: key, index, status: MS_DISPUTED, outcome });
        Ok(())
    }

    /// v1 arbiter decides a disputed milestone. Later versions route this to the shark panel.
    pub fn resolve(ctx: Context<Arbitrate>, index: u8, approve: bool) -> Result<()> {
        let key = ctx.accounts.escrow.key();
        let e = &mut ctx.accounts.escrow;
        require!(e.state == STATE_ACTIVE, EscrowError::WrongState);
        let i = index as usize;
        require!(i < e.milestones.len(), EscrowError::BadIndex);
        require!(
            e.milestones[i].status == MS_DISPUTED && e.dispute == index,
            EscrowError::WrongMilestoneStatus
        );
        let final_vote = if approve { VOTE_APPROVE } else { VOTE_REJECT };
        e.score_seats(i, final_vote);
        e.milestones[i].outcome = final_vote;
        if approve {
            e.milestones[i].status = MS_PASSED;
            if e.disputed_by == BY_CLIENT {
                e.client_strike = true;
            }
        } else {
            e.milestones[i].status = MS_FAILED;
            set_fault(e, key);
        }
        e.dispute = DISPUTE_NONE;
        e.disputed_by = BY_AUTO;
        let status = e.milestones[i].status;
        emit!(MilestoneChanged { escrow: key, index, status, outcome: final_vote });
        Ok(())
    }

    /// Permissionless. Applies the stored policy once a deadline has passed; pays the caller a tip.
    pub fn crank(ctx: Context<Act>, index: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let key = ctx.accounts.escrow.key();
        let e = &mut ctx.accounts.escrow;

        if index == ESCROW_LEVEL {
            match e.state {
                STATE_FUNDING if now >= e.funding_deadline => {
                    e.state = STATE_REFUNDED;
                }
                STATE_WARRANTY if now >= e.warranty_end => {
                    e.state = STATE_COMPLETED;
                }
                _ => return err!(EscrowError::NothingToDo),
            }
            emit!(StateChanged { escrow: key, state: e.state, fault: e.fault });
            return pay_tip(e, &ctx.accounts.caller);
        }

        require!(e.state == STATE_ACTIVE, EscrowError::WrongState);
        let i = index as usize;
        require!(i < e.milestones.len(), EscrowError::BadIndex);
        let mt = &e.terms.milestones[i];
        let (release, on_missed) = (mt.release, mt.on_missed);
        let deadline = e.activated_at + mt.deadline as i64;
        let ms = e.milestones[i];
        match ms.status {
            MS_PENDING if now >= deadline => match release {
                RELEASE_DEADLINE => e.milestones[i].status = MS_PASSED,
                RELEASE_VOTE => {
                    // Deliverable due; voting opens even if no guarantor has voted yet.
                    e.milestones[i].status = MS_VOTING;
                    e.milestones[i].vote_deadline = now + e.terms.vote_window as i64;
                }
                _ if on_missed == ON_MISSED_RELEASE => e.milestones[i].status = MS_PASSED,
                _ => {
                    e.milestones[i].status = MS_FAILED;
                    set_fault(e, key);
                }
            },
            MS_VOTING if now >= ms.vote_deadline => {
                require!(e.dispute == DISPUTE_NONE, EscrowError::DisputeOpen);
                e.milestones[i].status = MS_DISPUTED;
                e.dispute = index;
                e.disputed_by = BY_AUTO;
            }
            MS_CONTESTABLE if now >= ms.contest_deadline => {
                e.score_seats(i, ms.outcome);
                if ms.outcome == VOTE_APPROVE {
                    e.milestones[i].status = MS_PASSED;
                } else {
                    e.milestones[i].status = MS_FAILED;
                    set_fault(e, key);
                }
            }
            _ => return err!(EscrowError::NothingToDo),
        }
        let st = e.milestones[i];
        emit!(MilestoneChanged { escrow: key, index, status: st.status, outcome: st.outcome });
        pay_tip(e, &ctx.accounts.caller)
    }

    /// Permissionless. Pays a passed milestone to the service, keeping the warranty hold.
    pub fn payout(ctx: Context<Payout>, index: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let key = ctx.accounts.escrow.key();
        let e = &ctx.accounts.escrow;
        require!(e.state == STATE_ACTIVE || e.state == STATE_FAULTED, EscrowError::WrongState);
        let i = index as usize;
        require!(i < e.milestones.len(), EscrowError::BadIndex);
        require!(e.milestones[i].status == MS_PASSED, EscrowError::WrongMilestoneStatus);
        let weights: Vec<u16> = e.terms.milestones.iter().map(|m| m.weight_bps).collect();
        let amount = milestone_amount(e.terms.price, &weights, i);
        let hold = math::bps_floor(amount, e.terms.warranty_hold_bps);
        let pay = amount - hold;

        let hash = e.terms.terms_hash;
        let bump = [e.bump];
        let seeds: &[&[u8]] = &[ESCROW_SEED, &hash, &bump];
        vault_out(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            ctx.accounts.service_token.to_account_info(),
            ctx.accounts.escrow.to_account_info(),
            seeds,
            pay,
        )?;

        let e = &mut ctx.accounts.escrow;
        e.milestones[i].status = MS_PAID;
        e.released += pay;
        e.held += hold;
        emit!(MilestonePaid { escrow: key, index, paid: pay, held: hold });
        if e.state == STATE_ACTIVE && e.milestones.iter().all(|m| m.status == MS_PAID) {
            if e.terms.warranty_period > 0 {
                e.state = STATE_WARRANTY;
                e.warranty_end = now + e.terms.warranty_period as i64;
            } else {
                e.state = STATE_COMPLETED;
            }
            emit!(StateChanged { escrow: key, state: e.state, fault: e.fault });
        }
        pay_tip(e, &ctx.accounts.caller)
    }

    pub fn claim_warranty(ctx: Context<Act>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let key = ctx.accounts.escrow.key();
        let e = &mut ctx.accounts.escrow;
        require!(e.state == STATE_WARRANTY, EscrowError::WrongState);
        require_keys_eq!(ctx.accounts.caller.key(), e.terms.client, EscrowError::NotAParty);
        require!(now < e.warranty_end, EscrowError::TooLate);
        e.state = STATE_WARRANTY_DISPUTE;
        e.dispute = DISPUTE_WARRANTY;
        e.disputed_by = BY_CLIENT;
        emit!(StateChanged { escrow: key, state: e.state, fault: e.fault });
        Ok(())
    }

    pub fn resolve_warranty(ctx: Context<Arbitrate>, uphold: bool) -> Result<()> {
        let key = ctx.accounts.escrow.key();
        let e = &mut ctx.accounts.escrow;
        require!(e.state == STATE_WARRANTY_DISPUTE, EscrowError::WrongState);
        if uphold {
            set_fault(e, key);
        } else {
            e.state = STATE_COMPLETED;
            e.client_strike = true;
            emit!(StateChanged { escrow: key, state: e.state, fault: e.fault });
        }
        e.dispute = DISPUTE_NONE;
        e.disputed_by = BY_AUTO;
        Ok(())
    }

    /// Permissionless. Splits the vault per outcome, closes the vault where possible,
    /// and returns the escrow account's rent and unused tips to its creator.
    /// Remaining accounts: one token account per guarantor seat, in seat order.
    pub fn close<'info>(ctx: Context<'_, '_, 'info, 'info, Close<'info>>) -> Result<()> {
        let e = &ctx.accounts.escrow;
        let outcome = match e.state {
            STATE_COMPLETED => Outcome::Completed,
            STATE_FAULTED => Outcome::ServiceFault,
            STATE_REFUNDED => Outcome::Refunded,
            _ => return err!(EscrowError::WrongState),
        };
        // A passed milestone is owed to the service; pay it out before closing.
        require!(
            e.milestones.iter().all(|m| m.status != MS_PASSED),
            EscrowError::WrongMilestoneStatus
        );
        let seats = e.terms.guarantors.clone();
        require!(ctx.remaining_accounts.len() == seats.len(), EscrowError::GuarantorAccounts);
        let payable: Vec<bool> = (0..seats.len())
            .map(|s| {
                outcome != Outcome::Refunded && e.seat_ok & (1 << s) != 0 && e.seat_bad & (1 << s) == 0
            })
            .collect();
        let paid_seats = payable.iter().filter(|p| **p).count() as u32;
        let out = settle(&SettleIn {
            outcome,
            price: e.terms.price,
            service_bond: e.terms.service_bond,
            client_bond: e.terms.client_bond,
            protocol_fee: e.protocol_fee,
            guarantor_fee: e.guarantor_fee,
            client_funded: e.client_funded,
            service_funded: e.service_funded,
            released: e.released,
            service_fault_bps: e.terms.service_fault_bps,
            client_fault_bps: e.terms.client_fault_bps,
            client_strike: e.client_strike,
            paid_seats,
        });

        let hash = e.terms.terms_hash;
        let (state, fault, strike) = (e.state, e.fault, e.client_strike);
        let bump = [e.bump];
        let seeds: &[&[u8]] = &[ESCROW_SEED, &hash, &bump];
        let escrow_key = ctx.accounts.escrow.key();
        let escrow_info = ctx.accounts.escrow.to_account_info();
        let a = &ctx.accounts;
        let send = |to: AccountInfo<'info>, amount: u64| -> Result<()> {
            vault_out(&a.token_program, &a.vault, &a.mint, to, escrow_info.clone(), seeds, amount)
        };
        send(a.service_token.to_account_info(), out.to_service)?;
        send(a.client_token.to_account_info(), out.to_client)?;
        for (s, acc) in ctx.remaining_accounts.iter().enumerate() {
            let ta = InterfaceAccount::<TokenAccount>::try_from(acc)?;
            require!(ta.mint == a.mint.key() && ta.owner == seats[s], EscrowError::GuarantorAccounts);
            if payable[s] {
                send(acc.clone(), out.per_guarantor)?;
            }
        }
        // Treasury takes its share plus any remainder, so the vault ends empty.
        let vault_info = a.vault.to_account_info();
        // Token account layout (SPL Token and Token-2022): amount is the u64 at bytes 64..72.
        let remaining = {
            let d = vault_info.try_borrow_data()?;
            u64::from_le_bytes(d[64..72].try_into().map_err(|_| error!(EscrowError::Overflow))?)
        };
        send(a.treasury_token.to_account_info(), remaining)?;

        // A Token-2022 vault holding withheld transfer fees cannot be closed; it is left open.
        if a.mint_allow.flags & FLAG_TRANSFER_FEE == 0 {
            token_interface::close_account(CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                CloseAccount {
                    account: vault_info,
                    destination: a.creator.to_account_info(),
                    authority: escrow_info.clone(),
                },
                &[seeds],
            ))?;
        }

        emit!(EscrowClosed {
            escrow: escrow_key,
            terms_hash: hash,
            state,
            fault,
            client_strike: strike,
            to_service: out.to_service,
            to_client: out.to_client,
            to_guarantors: out.per_guarantor * paid_seats as u64,
            to_treasury: remaining,
        });
        Ok(())
    }
}

fn set_fault(e: &mut Escrow, key: Pubkey) {
    e.state = STATE_FAULTED;
    e.fault = FAULT_SERVICE;
    emit!(StateChanged { escrow: key, state: e.state, fault: e.fault });
}

/// Moves the crank tip from the escrow's reserved lamports to whoever turned the crank.
fn pay_tip<'info>(e: &mut Account<'info, Escrow>, caller: &Signer<'info>) -> Result<()> {
    let tip = e.terms.crank_tip.min(e.tip_pool);
    if tip == 0 {
        return Ok(());
    }
    e.tip_pool -= tip;
    let from = e.to_account_info();
    **from.try_borrow_mut_lamports()? -= tip;
    **caller.to_account_info().try_borrow_mut_lamports()? += tip;
    Ok(())
}

fn vault_out<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked { from: vault.to_account_info(), mint: mint.to_account_info(), to, authority },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = Config::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = program.programdata_address().ok().flatten() == Some(program_data.key()))]
    pub program: Program<'info, program::SolmlEscrow>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()))]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct AllowMint<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    /// CHECK: parsed by the mint gate; owner must be the given token program.
    #[account(owner = token_program.key())]
    pub mint: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        space = MintAllow::SPACE,
        seeds = [MINT_SEED, mint.key().as_ref()],
        bump
    )]
    pub mint_allow: Account<'info, MintAllow>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(terms: EscrowTerms)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [MINT_SEED, terms.settle_mint.as_ref()], bump = mint_allow.bump)]
    pub mint_allow: Box<Account<'info, MintAllow>>,
    #[account(address = terms.settle_mint, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = creator,
        space = Escrow::space(&terms),
        seeds = [ESCROW_SEED, terms.terms_hash.as_ref()],
        bump
    )]
    pub escrow: Box<Account<'info, Escrow>>,
    #[account(
        init,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = escrow,
        associated_token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub depositor: Signer<'info>,
    #[account(mut)]
    pub escrow: Box<Account<'info, Escrow>>,
    #[account(address = escrow.terms.settle_mint, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow,
        associated_token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = depositor,
        token::token_program = token_program
    )]
    pub from: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Shared context for actions that only touch escrow state: verify, vote, contest, crank, claim.
#[derive(Accounts)]
pub struct Act<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut)]
    pub escrow: Box<Account<'info, Escrow>>,
}

#[derive(Accounts)]
pub struct Arbitrate<'info> {
    pub arbiter: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = arbiter)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub escrow: Box<Account<'info, Escrow>>,
}

#[derive(Accounts)]
pub struct Payout<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut)]
    pub escrow: Box<Account<'info, Escrow>>,
    #[account(address = escrow.terms.settle_mint, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow,
        associated_token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = escrow.terms.service,
        token::token_program = token_program
    )]
    pub service_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Close<'info> {
    pub caller: Signer<'info>,
    #[account(mut, close = creator)]
    pub escrow: Box<Account<'info, Escrow>>,
    /// CHECK: receives rent and unused tips; must be the escrow's creator.
    #[account(mut, address = escrow.creator)]
    pub creator: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [MINT_SEED, escrow.terms.settle_mint.as_ref()], bump = mint_allow.bump)]
    pub mint_allow: Box<Account<'info, MintAllow>>,
    #[account(address = escrow.terms.settle_mint, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow,
        associated_token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = escrow.terms.service,
        token::token_program = token_program
    )]
    pub service_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = escrow.terms.client,
        token::token_program = token_program
    )]
    pub client_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = config.treasury,
        token::token_program = token_program
    )]
    pub treasury_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}
