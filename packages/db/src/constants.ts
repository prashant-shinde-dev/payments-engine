// House/system account ids, pinned by migrations 20260817064659 and 20260817065501. Keep in sync with that
// migration's literals and the test seed. Safe to be public: no path trusts a
// client-supplied account id (see the CUSTOMER guard in wallet.service).
export const HOUSE_USER_ID = "00000000-0000-4000-8000-000000000001";
export const HOUSE_WALLET_ID = "00000000-0000-4000-8000-000000000002";
export const CLEARING_ACC_USER_ID = "00000000-0000-4000-8000-000000000003";
export const CLEARING_ACC_WALLET_ID = "00000000-0000-4000-8000-000000000004";
