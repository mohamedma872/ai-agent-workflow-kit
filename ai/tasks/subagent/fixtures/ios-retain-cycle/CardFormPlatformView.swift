import Flutter
import UIKit

/// Native card form shown inside the checkout screen as a Flutter platform view.
final class CardFormPlatformView: NSObject, FlutterPlatformView {
    private let container = UIView()
    private let channel: FlutterMethodChannel
    private var form: CardFormComponent?
    private var tokenizeAction: (() -> Void)?
    private var isValidAction: (() -> Bool)?

    init(messenger: FlutterBinaryMessenger) {
        channel = FlutterMethodChannel(name: "shop/card_form", binaryMessenger: messenger)
        super.init()

        let form = CardFormComponent()
        form.onTokenized = { token in
            self.channel.invokeMethod("tokenized", arguments: token)
        }
        self.form = form

        tokenizeAction = {
            self.form?.tokenize()
        }
        isValidAction = {
            return self.form?.isValid ?? false
        }

        channel.setMethodCallHandler { call, result in
            switch call.method {
            case "tokenize":
                self.tokenizeAction?()
                result(nil)
            case "isValid":
                result(self.isValidAction?() ?? false)
            default:
                result(FlutterMethodNotImplemented)
            }
        }
        container.addSubview(form.view)
    }

    func view() -> UIView { container }

    /// Releases the channel so a later checkout screen can own it.
    deinit {
        channel.setMethodCallHandler(nil)
    }
}
