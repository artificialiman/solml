//! Pure settlement arithmetic. No accounts; unit-tested on the host.

use crate::state::BPS;

pub fn bps_floor(amount: u64, bps: u16) -> u64 {
    ((amount as u128 * bps as u128) / BPS as u128) as u64
}

pub fn bps_ceil(amount: u64, bps: u16) -> u64 {
    ((amount as u128 * bps as u128).div_ceil(BPS as u128)) as u64
}

/// ⌈2N/3⌉ seats.
pub fn vote_threshold(seats: usize) -> usize {
    (2 * seats).div_ceil(3)
}

/// Milestone i's share of the price. The last milestone takes the remainder so no dust is left.
pub fn milestone_amount(price: u64, weights: &[u16], index: usize) -> u64 {
    let last = weights.len() - 1;
    if index < last {
        bps_floor(price, weights[index])
    } else {
        let others: u64 = weights[..last].iter().map(|w| bps_floor(price, *w)).sum();
        price - others
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Completed,
    ServiceFault,
    Refunded,
}

pub struct SettleIn {
    pub outcome: Outcome,
    pub price: u64,
    pub service_bond: u64,
    pub client_bond: u64,
    pub protocol_fee: u64,
    pub guarantor_fee: u64,
    pub client_funded: u64,
    pub service_funded: u64,
    pub released: u64,
    pub service_fault_bps: u16,
    pub client_fault_bps: u16,
    pub client_strike: bool,
    /// Seats paid a guarantor fee share.
    pub paid_seats: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub struct SettleOut {
    pub to_service: u64,
    pub to_client: u64,
    pub per_guarantor: u64,
    pub to_treasury: u64,
}

impl SettleOut {
    pub fn total(&self, paid_seats: u32) -> u64 {
        self.to_service + self.to_client + self.per_guarantor * paid_seats as u64 + self.to_treasury
    }
}

/// Splits everything the vault holds. Sum of outputs == client_funded + service_funded − released.
pub fn settle(i: &SettleIn) -> SettleOut {
    if i.outcome == Outcome::Refunded {
        return SettleOut {
            to_service: i.service_funded,
            to_client: i.client_funded,
            per_guarantor: 0,
            to_treasury: 0,
        };
    }
    let client_required = i.price + i.protocol_fee + i.guarantor_fee + i.client_bond;
    let excess_c = i.client_funded - client_required;
    let excess_s = i.service_funded - i.service_bond;
    let unreleased = i.price - i.released;

    let (mut to_service, mut to_client) = match i.outcome {
        Outcome::Completed => (unreleased + i.service_bond + excess_s, i.client_bond + excess_c),
        Outcome::ServiceFault => {
            let slash = bps_floor(i.service_bond, i.service_fault_bps);
            (i.service_bond - slash + excess_s, unreleased + i.client_bond + excess_c + slash)
        }
        Outcome::Refunded => unreachable!(),
    };
    if i.client_strike {
        let strike = bps_floor(i.client_bond, i.client_fault_bps);
        to_client -= strike;
        to_service += strike;
    }
    let (per_guarantor, g_rest) = if i.paid_seats > 0 {
        let share = i.guarantor_fee / i.paid_seats as u64;
        (share, i.guarantor_fee - share * i.paid_seats as u64)
    } else {
        (0, i.guarantor_fee)
    };
    SettleOut {
        to_service,
        to_client,
        per_guarantor,
        to_treasury: i.protocol_fee + g_rest,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(outcome: Outcome) -> SettleIn {
        SettleIn {
            outcome,
            price: 20_000_000_000,
            service_bond: 4_000_000_000,
            client_bond: 1_000_000_000,
            protocol_fee: 100_000_000,
            guarantor_fee: 200_000_000,
            client_funded: 21_300_000_000,
            service_funded: 4_000_000_000,
            released: 0,
            service_fault_bps: 7_500,
            client_fault_bps: 5_000,
            client_strike: false,
            paid_seats: 3,
        }
    }

    fn vault(i: &SettleIn) -> u64 {
        i.client_funded + i.service_funded - i.released
    }

    #[test]
    fn threshold_is_two_thirds_rounded_up() {
        assert_eq!([1, 2, 3, 4, 5].map(vote_threshold), [1, 2, 2, 3, 4]);
    }

    #[test]
    fn milestones_sum_to_price_with_no_dust() {
        let w = [3_333u16, 3_333, 3_334];
        let price = 1_000_000_007u64;
        let total: u64 = (0..3).map(|i| milestone_amount(price, &w, i)).sum();
        assert_eq!(total, price);
    }

    #[test]
    fn bps_rounding() {
        assert_eq!(bps_floor(999, 5_000), 499);
        assert_eq!(bps_ceil(999, 5_000), 500);
        assert_eq!(bps_floor(u64::MAX, 10_000), u64::MAX);
    }

    #[test]
    fn completed_splits_whole_vault() {
        let mut i = base(Outcome::Completed);
        // All milestones paid with a 10% hold: 18,000 released, 2,000 held.
        i.released = 18_000_000_000;
        let o = settle(&i);
        assert_eq!(o.to_service, 2_000_000_000 + 4_000_000_000);
        assert_eq!(o.to_client, 1_000_000_000);
        assert_eq!(o.per_guarantor, 66_666_666);
        assert_eq!(o.to_treasury, 100_000_000 + 2);
        assert_eq!(o.total(3), vault(&i));
    }

    #[test]
    fn service_fault_refunds_unreleased_and_slashes_bond() {
        let mut i = base(Outcome::ServiceFault);
        i.released = 7_200_000_000; // first milestone (40%) paid, 10% held
        let o = settle(&i);
        assert_eq!(o.to_service, 1_000_000_000);
        assert_eq!(o.to_client, 12_800_000_000 + 1_000_000_000 + 3_000_000_000);
        assert_eq!(o.total(3), vault(&i));
    }

    #[test]
    fn client_strike_moves_bond_share_to_service() {
        let mut i = base(Outcome::Completed);
        i.client_strike = true;
        i.released = 20_000_000_000;
        let o = settle(&i);
        assert_eq!(o.to_client, 500_000_000);
        assert_eq!(o.to_service, 4_500_000_000);
        assert_eq!(o.total(3), vault(&i));
    }

    #[test]
    fn no_paid_seats_sends_guarantor_fee_to_treasury() {
        let mut i = base(Outcome::Completed);
        i.paid_seats = 0;
        i.released = 20_000_000_000;
        let o = settle(&i);
        assert_eq!(o.to_treasury, 300_000_000);
        assert_eq!(o.total(0), vault(&i));
    }

    #[test]
    fn refund_returns_exact_credits() {
        let i = base(Outcome::Refunded);
        let o = settle(&i);
        assert_eq!((o.to_client, o.to_service, o.to_treasury), (21_300_000_000, 4_000_000_000, 0));
    }

    #[test]
    fn excess_deposit_goes_back_to_depositor() {
        let mut i = base(Outcome::Completed);
        i.client_funded += 5;
        i.released = 20_000_000_000;
        let o = settle(&i);
        assert_eq!(o.to_client, 1_000_000_005);
        assert_eq!(o.total(3), vault(&i));
    }
}
