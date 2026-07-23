// House/system account ids, pinned by migration 20260721131500. Keep in sync with that
// migration's literals and the test seed. Safe to be public: no path trusts a
// client-supplied account id (see the SYSTEM guard in wallet.service).
export const HOUSE_USER_ID = "00000000-0000-0000-0000-000000000001";
export const HOUSE_WALLET_ID = "00000000-0000-0000-0000-000000000002";
