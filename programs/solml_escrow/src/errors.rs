use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Terms version is not supported by this program")]
    UnsupportedVersion,
    #[msg("A wallet appears in more than one role")]
    SamePartyTwice,
    #[msg("More than 5 guarantor seats")]
    TooManyGuarantors,
    #[msg("Price must be above zero")]
    ZeroPrice,
    #[msg("A rate is outside its bounds")]
    BadRate,
    #[msg("Crank tip is outside 5,000..=1,000,000 lamports")]
    BadCrankTip,
    #[msg("A window is shorter than one hour")]
    WindowTooShort,
    #[msg("Milestone list or milestone fields are invalid")]
    BadMilestones,
    #[msg("Checks do not match the release mode, or exceed 6")]
    BadChecks,
    #[msg("A vote milestone needs at least one guarantor")]
    VoteWithoutGuarantors,
    #[msg("Milestone weights must sum to 10,000 bps")]
    WeightsNot100,
    #[msg("Terms decimals differ from the mint")]
    DecimalsMismatch,
    #[msg("Mint was not allowed through the mint gate")]
    MintNotAllowed,
    #[msg("Mint has a permanent delegate")]
    PermanentDelegate,
    #[msg("Mint is non-transferable")]
    NonTransferable,
    #[msg("Mint has a transfer hook; v1 does not route hook accounts")]
    TransferHook,
    #[msg("Mint creates accounts frozen by default")]
    DefaultFrozen,
    #[msg("Account is not a token mint")]
    NotAMint,
    #[msg("Protocol fee above 200 bps")]
    ProtocolFeeTooHigh,
    #[msg("Signer is not a party to this escrow")]
    NotAParty,
    #[msg("Signer does not hold a guarantor seat")]
    NotAGuarantor,
    #[msg("Signer is not the arbiter")]
    NotArbiter,
    #[msg("Escrow is not in the state this action needs")]
    WrongState,
    #[msg("Milestone is not in the status this action needs")]
    WrongMilestoneStatus,
    #[msg("Milestone index is out of range")]
    BadIndex,
    #[msg("This side has already funded")]
    AlreadyFunded,
    #[msg("Vault credit is below the required deposit")]
    Underfunded,
    #[msg("Funding window has closed")]
    FundingClosed,
    #[msg("Deadline has not passed yet")]
    TooEarly,
    #[msg("Window has already closed")]
    TooLate,
    #[msg("Seat has already voted on this milestone")]
    AlreadyVoted,
    #[msg("Checks must pass before guarantors vote")]
    ChecksFirst,
    #[msg("Only the losing side may contest")]
    CannotContest,
    #[msg("Another dispute is open on this escrow")]
    DisputeOpen,
    #[msg("Check account does not match the terms")]
    CheckAccountMismatch,
    #[msg("Nothing to do: no deadline has passed for this item")]
    NothingToDo,
    #[msg("Guarantor token accounts must be passed in seat order")]
    GuarantorAccounts,
    #[msg("Arithmetic overflow")]
    Overflow,
}
