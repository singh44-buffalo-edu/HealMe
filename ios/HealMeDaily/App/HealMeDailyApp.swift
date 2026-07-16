import SwiftUI

/// App entry: builds the one AppModel and hands it to the shell. The design
/// system is light-first with absolute ink-on-paper values, so the UI is
/// pinned to light appearance (a dark variant is a deliberate future design
/// task, not a free toggle).
@main
struct HealMeDailyApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.light)
                .tint(T.green)
        }
    }
}
