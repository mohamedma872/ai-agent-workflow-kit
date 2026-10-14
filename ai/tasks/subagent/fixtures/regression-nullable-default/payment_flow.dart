// Behavior-preserving refactor review fixture. Both versions are shown; the
// branch claims no behavior change. Fake code, not from any real project.

// ===== BASE (merge base) =====
class ContactInfo {
  final String? threedUrl; // null when the card payment needs no 3-D Secure step
  ContactInfo({this.threedUrl});
  factory ContactInfo.fromJson(Map<String, dynamic> j) => ContactInfo(threedUrl: j['threedUrl'] as String?);
}

Future<void> onSavedCardPaid(ContactInfo model) async {
  if (model.threedUrl != null) {
    await openPaymentWebView(model.threedUrl!);
  } else {
    clearCart();
    showOrderConfirmation();
  }
}

// ===== HEAD (branch) =====
class ContactInfoV2 {
  final String threedUrl;
  ContactInfoV2({this.threedUrl = ''});
  factory ContactInfoV2.fromJson(Map<String, dynamic> j) => ContactInfoV2(threedUrl: (j['threedUrl'] ?? '').toString());
}

Future<void> onSavedCardPaidV2(ContactInfoV2 model) async {
  await openPaymentWebView(model.threedUrl);
}

Future<void> openPaymentWebView(String url) async {}
void clearCart() {}
void showOrderConfirmation() {}
