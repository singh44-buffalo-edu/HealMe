import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import UIKit
import HealMeDailyKit

/// Documents — ingestion upload + the human review gate.
///
/// Two ingestion paths, deliberately distinct (CLAUDE.md §3):
/// - PDFs/photos → `uploadDocument` (OCR/AI extraction). NOTHING from this
///   path enters the clinical record until the owner approves each proposal
///   in the review queue below — the approve call commits resource +
///   Provenance atomically server-side.
/// - Structured exports (FHIR JSON / CSV / Apple Health XML / C-CDA / HL7v2)
///   → `importStructured` (deterministic importers, direct commit with
///   content-hash dedup + Provenance). The review queue is for AI
///   extractions only.
struct DocumentsView: View {
    @Environment(AppModel.self) private var model

    // Capture state
    @State private var photoItem: PhotosPickerItem?
    @State private var showCamera = false
    @State private var showFileImporter = false
    @State private var uploadBusy = false
    @State private var uploadError: String?
    @State private var outcome: UploadOutcome?

    // Review queue state
    @State private var tasks: [AIService.ReviewTask] = []
    @State private var queueLoaded = false
    @State private var queueError: String?
    @State private var approvingId: String?
    @State private var rejectingId: String?

    /// Non-nil when the upload pipeline would send document contents to a
    /// non-local provider — the BoundaryRow names it BEFORE the user sends
    /// anything (data-boundary rule).
    @State private var cloudRecipient: String?

    /// What the last upload produced — the wording differs on purpose:
    /// AI extraction creates *proposals*, structured import *commits*.
    private enum UploadOutcome {
        case proposals(Int)
        case imported(AIService.ImportResult)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    PageHeader(
                        title: "Documents",
                        subtitle: "Bring records in — you approve every AI extraction."
                    )
                    VaultChip()
                }

                captureCard

                if let uploadError {
                    ErrorBanner(message: uploadError)
                }
                if let outcome {
                    outcomeCard(outcome)
                }

                reviewQueueSection

                Text("Originals are kept immutably; AI extractions NEVER enter your record without your approval here.")
                    .font(.mono(10.5))
                    .foregroundStyle(T.quaternary)
                DisclaimerFooter()
            }
            .padding(16)
        }
        .background(T.canvas)
        .navigationTitle("Documents")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await reloadTasks()
            queueLoaded = true
            await loadBoundary()
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            photoItem = nil // allow re-picking the same photo later
            Task {
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else {
                        uploadError = "Could not read the selected photo."
                        return
                    }
                    await performUpload(data: data, filename: "photo.jpg", mimeType: "image/jpeg")
                } catch {
                    uploadError = error.localizedDescription
                }
            }
        }
        .sheet(isPresented: $showCamera) {
            CameraPicker { data in
                showCamera = false
                Task { await performUpload(data: data, filename: "photo.jpg", mimeType: "image/jpeg") }
            } onCancel: {
                showCamera = false
            }
            .ignoresSafeArea()
        }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.pdf, .json, .commaSeparatedText, .xml, .data],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                if let url = urls.first { handlePicked(url: url) }
            case .failure(let error):
                uploadError = error.localizedDescription
            }
        }
    }

    // MARK: - Capture

    private var cameraAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    private var captureCard: some View {
        DsCard {
            Eyebrow(text: "Capture")
            Text("PDFs and photos go through OCR + AI extraction into the review queue below. "
                + "Structured exports — FHIR JSON, CSV, Apple Health XML, C-CDA, HL7v2 — import directly with dedup.")
                .font(.ui(12.5))
                .foregroundStyle(T.secondary)

            // Cloud boundary disclosed BEFORE any data is sent (rule: cloud
            // boundaries are never implicit). Keyed to what the server
            // ACTUALLY does: the upload pipeline uses the legacy default
            // provider and does not honor the ingest-extraction routing
            // switch yet (tracked separately).
            if let cloudRecipient {
                BoundaryRow(recipient: cloudRecipient)
            }

            HStack(spacing: 10) {
                PhotosPicker(selection: $photoItem, matching: .images) {
                    pickerLabel("Photo library")
                }
                .disabled(uploadBusy)

                PillButton(title: "Camera", variant: .secondary) {
                    showCamera = true
                }
                .disabled(uploadBusy || !cameraAvailable)
                .opacity(cameraAvailable ? 1 : 0.45)
            }

            PillButton(title: "Choose file", variant: .secondary) {
                showFileImporter = true
            }
            .disabled(uploadBusy)

            if uploadBusy {
                HStack(spacing: 8) {
                    ProgressView()
                        .tint(T.green)
                    Text("Uploading — OCR + extraction can take tens of seconds.")
                        .font(.ui(12))
                        .foregroundStyle(T.secondary)
                }
            } else {
                Text("OCR + extraction can take tens of seconds.")
                    .font(.ui(11))
                    .foregroundStyle(T.quaternary)
            }
        }
    }

    /// PhotosPicker label styled like a secondary PillButton (PhotosPicker
    /// supplies its own Button chrome, so we only draw the label).
    private func pickerLabel(_ title: String) -> some View {
        Text(title)
            .font(.ui(13.5, weight: .semibold))
            .foregroundStyle(T.ink)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 46)
            .background(T.chip, in: Capsule())
    }

    // MARK: - Upload result note

    private func outcomeCard(_ outcome: UploadOutcome) -> some View {
        DsCard(padding: 14) {
            switch outcome {
            case .proposals(let count):
                // Mandatory review-gate wording — the number is data (mono),
                // the sentence is prose (system font).
                (
                    Text("\(count) ").font(.mono(13, weight: .semibold))
                        + Text("proposals created — nothing is committed until you approve below.")
                        .font(.ui(12.5))
                )
                .foregroundStyle(T.ink)
            case .imported(let result):
                let skippedTotal = result.skipped.values.reduce(0, +)
                Text("imported \(result.imported) · already existed \(result.already_existed) · skipped \(skippedTotal)")
                    .font(.mono(12, weight: .medium))
                    .foregroundStyle(T.ink)
            }
        }
    }

    // MARK: - Review queue

    private var reviewQueueSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Eyebrow(text: "Review queue")
                Text("\(tasks.count)")
                    .font(.mono(10, weight: .medium))
                    .foregroundStyle(T.tertiary)
                Spacer()
            }
            Text("Approve = it becomes part of your record (committed with provenance). Reject = nothing is created.")
                .font(.ui(11))
                .foregroundStyle(T.tertiary)

            if let queueError {
                ErrorBanner(message: queueError)
            }

            if !queueLoaded {
                HStack {
                    Spacer()
                    ProgressView()
                        .tint(T.green)
                    Spacer()
                }
                .padding(.vertical, 16)
            } else if tasks.isEmpty {
                EmptyNote(text: "Nothing waiting for review.")
            } else {
                ForEach(tasks) { task in
                    taskCard(task)
                }
            }
        }
    }

    private func taskCard(_ task: AIService.ReviewTask) -> some View {
        DsCard(ai: true) {
            HStack {
                AIPill(text: "AI proposal")
                Spacer()
                if let authored = task.authored_on {
                    Text(Fmt.when(authored))
                        .font(.mono(10))
                        .foregroundStyle(T.quaternary)
                }
            }

            Text(task.description)
                .font(.ui(14, weight: .semibold))
                .foregroundStyle(T.ink)

            if let confidence = task.confidence {
                confidenceBar(confidence)
            }

            if let excerpt = task.source_excerpt, !excerpt.isEmpty {
                Text(excerpt)
                    .font(.mono(10.5))
                    .foregroundStyle(T.quaternary)
                    .lineLimit(4)
            }

            HStack(spacing: 10) {
                PillButton(title: "Approve into record", variant: .primary, busy: approvingId == task.task_id) {
                    approve(task)
                }
                PillButton(title: "Reject", variant: .destructive, busy: rejectingId == task.task_id) {
                    reject(task)
                }
            }
            .disabled(approvingId != nil || rejectingId != nil)
        }
    }

    /// Thin AI-confidence bar: indigo fill on the indigo-tinted track, mono
    /// percent — confidence is AI metadata, so the AI hue is the right one.
    private func confidenceBar(_ confidence: Double) -> some View {
        let fraction = min(max(confidence, 0), 1)
        return HStack(spacing: 8) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(T.aiBg)
                    Capsule().fill(T.ai)
                        .frame(width: max(geo.size.width * fraction, fraction > 0 ? 3 : 0))
                }
            }
            .frame(height: 4)
            Text("\(Int((fraction * 100).rounded()))%")
                .font(.mono(10, weight: .medium))
                .foregroundStyle(T.ai)
        }
    }

    // MARK: - Actions

    /// OCR/AI extraction path — creates proposals only, never commits.
    private func performUpload(data: Data, filename: String, mimeType: String) async {
        uploadBusy = true
        uploadError = nil
        outcome = nil
        do {
            let result = try await model.ai.uploadDocument(data: data, filename: filename, mimeType: mimeType)
            outcome = .proposals(result.proposals_created)
            await reloadTasks()
            await model.refreshCore() // review-queue badge
        } catch {
            uploadError = error.localizedDescription
        }
        uploadBusy = false
    }

    /// Deterministic importer path — commits directly with dedup + Provenance.
    private func performImport(kind: String, data: Data, filename: String, mimeType: String) async {
        uploadBusy = true
        uploadError = nil
        outcome = nil
        do {
            let result = try await model.ai.importStructured(kind: kind, data: data, filename: filename, mimeType: mimeType)
            outcome = .imported(result)
            await model.refreshCore()
        } catch {
            uploadError = error.localizedDescription
        }
        uploadBusy = false
    }

    /// Route a file-importer pick by extension. The URL is security-scoped:
    /// bytes must be read inside start/stopAccessingSecurityScopedResource.
    private func handlePicked(url: URL) {
        let filename = url.lastPathComponent
        let ext = url.pathExtension.lowercased()
        let accessed = url.startAccessingSecurityScopedResource()
        defer {
            if accessed { url.stopAccessingSecurityScopedResource() }
        }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            uploadError = "Could not read \(filename): \(error.localizedDescription)"
            return
        }

        switch ext {
        // OCR/AI extraction path (review-gated)
        case "pdf":
            Task { await performUpload(data: data, filename: filename, mimeType: "application/pdf") }
        case "jpg", "jpeg":
            Task { await performUpload(data: data, filename: filename, mimeType: "image/jpeg") }
        case "png":
            Task { await performUpload(data: data, filename: filename, mimeType: "image/png") }
        case "heic", "heif":
            Task { await performUpload(data: data, filename: filename, mimeType: "image/heic") }
        case "tif", "tiff":
            Task { await performUpload(data: data, filename: filename, mimeType: "image/tiff") }
        // Deterministic importers (direct commit with dedup)
        case "json":
            Task { await performImport(kind: "fhir", data: data, filename: filename, mimeType: "application/json") }
        case "csv":
            Task { await performImport(kind: "csv", data: data, filename: filename, mimeType: "text/csv") }
        case "xml":
            Task { await performImport(kind: "apple", data: data, filename: filename, mimeType: "application/xml") }
        case "cda", "ccda":
            Task { await performImport(kind: "ccda", data: data, filename: filename, mimeType: "application/xml") }
        case "hl7":
            Task { await performImport(kind: "hl7", data: data, filename: filename, mimeType: "text/plain") }
        default:
            uploadError = "Unsupported file type “.\(ext)” — use a PDF, an image, FHIR JSON, CSV, Apple Health XML, C-CDA or HL7v2."
        }
    }

    private func reloadTasks() async {
        do {
            tasks = try await model.ai.listReviewTasks()
            queueError = nil
        } catch {
            queueError = error.localizedDescription
        }
    }

    /// The ONLY path by which AI/OCR output becomes a clinical resource —
    /// server-side it commits resource + Provenance atomically.
    private func approve(_ task: AIService.ReviewTask) {
        approvingId = task.task_id
        queueError = nil
        Task {
            do {
                try await model.ai.approveTask(taskId: task.task_id, resource: nil)
                await reloadTasks()
                await model.refreshCore() // badge count
            } catch {
                queueError = error.localizedDescription
            }
            approvingId = nil
        }
    }

    private func reject(_ task: AIService.ReviewTask) {
        rejectingId = task.task_id
        queueError = nil
        Task {
            do {
                try await model.ai.rejectTask(taskId: task.task_id)
                await reloadTasks()
                await model.refreshCore()
            } catch {
                queueError = error.localizedDescription
            }
            rejectingId = nil
        }
    }

    /// Best-effort boundary disclosure keyed to ACTUAL server behavior: the
    /// upload pipeline always uses the configured default provider (legacy
    /// `get_provider()`) and ignores the ingest-extraction routing switch
    /// (not yet honored server-side; tracked separately). So the row shows
    /// whenever a configured NON-LOCAL provider would be used, regardless of
    /// routing — and when we can't resolve whether it's local, we
    /// over-disclose and show it anyway.
    private func loadBoundary() async {
        guard let health = try? await model.ai.health(),
              health.ai.configured,
              let name = health.ai.provider else {
            // No reachable/configured provider: the server refuses the call
            // outright, so there is no boundary to disclose.
            cloudRecipient = nil
            return
        }
        if let provider = (try? await model.ai.aiSettings())?.providers.first(where: { $0.name == name }) {
            cloudRecipient = provider.is_local ? nil : "\(provider.name) (\(provider.model))"
        } else {
            // Can't resolve is_local — over-disclose rather than hide a
            // possible cloud boundary.
            cloudRecipient = health.ai.model.map { "\(name) (\($0))" } ?? name
        }
    }
}

// MARK: - Camera capture

/// Minimal UIImagePickerController wrapper for the capture card's camera
/// button (PhotosPicker has no camera source). JPEG at 0.9 quality, matching
/// the web capture path.
struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (Data) -> Void
    let onCancel: () -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let parent: CameraPicker

        init(_ parent: CameraPicker) {
            self.parent = parent
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.originalImage] as? UIImage,
               let data = image.jpegData(compressionQuality: 0.9) {
                parent.onImage(data)
            } else {
                parent.onCancel()
            }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.onCancel()
        }
    }
}
