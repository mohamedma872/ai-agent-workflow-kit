// Behavior-preserving refactor review fixture. Both versions are shown; the
// branch claims no behavior change. Fake code, not from any real project.

// ===== BASE (merge base) =====
class SlotPageState {
  void initState() {
    registerReceiver(['changeLocation', 'slotReservationFailed']).listen((event) {
      if (event.action == 'slotReservationFailed') {
        selectedSlot = null;
        errorMessage = event.data['message'];
        refreshSlots();
      }
    });
  }
}

class CartProvider {
  Future<void> submitDelivery() async {
    final res = await api.submitDeliveryInfo();
    if (res.reserveFailed) {
      sendBroadcast('slotReservationFailed', extras: {'message': res.message});
      return;
    }
    goToPayment();
  }
}

// ===== HEAD (branch) =====
class SlotPageStateV2 {
  void initState() {
    registerReceiver(['changeLocation']).listen((event) {
      reloadAddress();
    });
  }
}

class CartProviderV2 {
  Future<void> submitDelivery() async {
    final res = await api.submitDeliveryInfo();
    if (res.reserveFailed) {
      sendBroadcast('slotReservationFailed', extras: {'message': res.message});
      return;
    }
    goToPayment();
  }
}
