final channel = MethodChannel('payments'); Future<void> pay() async { final result = await channel.invokeMethod('pay'); print(result); }
