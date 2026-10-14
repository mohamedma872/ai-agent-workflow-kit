// Impact-verification fixture. Fake code, not from any real project.
//
// FINDING UNDER VERIFICATION (claimed severity: high):
//   "Out-of-stock bundles are no longer dimmed in the cart: HEAD inverted the
//    condition (cart_page.dart), so in-stock bundles look disabled."
//
// Three versions of the same widget are shown: the merge base, the branch head,
// and the current production branch (master).

// ===== BASE (merge base) — base/lib/cart/cart_page.dart:40 =====
Widget bundleBase(bool isOutOfStock) => Container(
      foregroundDecoration: isOutOfStock ? const BoxDecoration(color: Color(0x66FFFFFF)) : null,
    );

// ===== HEAD (branch) — head/lib/features/cart/cart_page.dart:52 =====
Widget bundleHead(bool isOutOfStock) => Container(
      foregroundDecoration: !isOutOfStock ? const BoxDecoration(color: Color(0x66FFFFFF)) : null,
    );

// ===== PRODUCTION (origin/master) — lib/cart/cart_page.dart:41, changed by master commit a1b2c3 "MAVS-77 bundle dimming" after the merge base =====
Widget bundleProduction(bool isOutOfStock) => Container(
      foregroundDecoration: !isOutOfStock ? const BoxDecoration(color: Color(0x66FFFFFF)) : null,
    );
