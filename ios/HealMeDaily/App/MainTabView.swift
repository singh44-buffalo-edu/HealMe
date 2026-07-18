import SwiftUI

/// Tab shell — the iOS counterpart of the web MobileTabBar. Five tabs:
/// Today (dose panel + due check-ins), Meds, Adherence, Assistant (the one
/// AI-identity tab), and More (everything else, mirroring the web More hub).
struct MainTabView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        // selection bound to the model so a push deep-link (model.route) can
        // switch tabs; tags are the same indices route(to:) uses.
        TabView(selection: $model.selectedTab) {
            NavigationStack {
                TodayView()
            }
            .tabItem {
                Label("Today", systemImage: "sun.max")
            }
            .tag(0)

            NavigationStack {
                MedsView()
            }
            .tabItem {
                Label("Meds", systemImage: "pills")
            }
            .tag(1)

            NavigationStack {
                AdherenceView()
            }
            .tabItem {
                Label("Adherence", systemImage: "chart.bar")
            }
            .tag(2)

            NavigationStack {
                AssistantView()
            }
            .tabItem {
                Label("Assistant", systemImage: "sparkles")
            }
            .tag(3)

            NavigationStack {
                MoreView()
            }
            .tabItem {
                Label("More", systemImage: "ellipsis.circle")
            }
            .badge(model.reviewQueueCount > 0 ? model.reviewQueueCount : 0)
            .tag(4)
        }
    }
}

/// The More hub: remaining surfaces, mirroring the web nav registry.
struct MoreView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            Section {
                NavigationLink {
                    QuickAddView()
                } label: {
                    Label("Quick add", systemImage: "plus.circle")
                }
                NavigationLink {
                    CheckinsView()
                } label: {
                    Label("Check-ins", systemImage: "checklist")
                }
                NavigationLink {
                    VitalsView()
                } label: {
                    Label("Vitals", systemImage: "heart")
                }
                NavigationLink {
                    TrendsView()
                } label: {
                    Label("Trends", systemImage: "chart.xyaxis.line")
                }
            }

            Section {
                NavigationLink {
                    RecordsView()
                } label: {
                    Label("Labs & records", systemImage: "testtube.2")
                }
                NavigationLink {
                    ProfileView()
                } label: {
                    Label("Profile", systemImage: "person.text.rectangle")
                }
                NavigationLink {
                    DocumentsView()
                } label: {
                    HStack {
                        Label("Documents", systemImage: "doc.on.doc")
                        Spacer()
                        if model.reviewQueueCount > 0 {
                            Text("\(model.reviewQueueCount) to review")
                                .font(.mono(10, weight: .medium))
                                .foregroundStyle(T.ai)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(T.aiBg, in: Capsule())
                        }
                    }
                }
                NavigationLink {
                    HealthReviewView()
                } label: {
                    Label("Health Review", systemImage: "doc.text.magnifyingglass")
                }
            }

            Section {
                NavigationLink {
                    SettingsView()
                } label: {
                    Label("Settings", systemImage: "gearshape")
                }
            } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Signed in as \(model.profileName)")
                        .font(.mono(11))
                    DisclaimerFooter()
                }
                .padding(.top, 8)
            }
        }
        .navigationTitle("More")
        .scrollContentBackground(.hidden)
        .background(T.canvas)
    }
}
