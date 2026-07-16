"""FHIR constants — mirrors FHIR-MAPPING.md.

Copied (not imported) from ai-service/app/fhir_consts.py: packages never
import across package boundaries in this repo. If a URL here ever drifts from
FHIR-MAPPING.md §1/§7/§9 (or from the ai-service/frontend copies), writes stop
being idempotent with the rest of the app — treat any edit as a cross-package
change and update all copies + the mapping doc together.

These are project-local systems under https://healmedaily.local/fhir/ — they
are deliberately NOT presented as LOINC/SNOMED/RxNorm (CLAUDE.md §3: never
invent standard codes).
"""

BASE = "https://healmedaily.local/fhir"
IDENT = BASE + "/identifier"
# statusReason coding for not-done administrations (user-skipped / user-marked-missed, §3)
CS_ADHERENCE = BASE + "/CodeSystem/adherence-reason"
# Device.type codes: medication-cartridge / pill-dispenser (§5)
CS_DEVICE = BASE + "/CodeSystem/device"
# CommunicationRequest.medium codes for escalation rungs: chime / push / ask-why (§9)
CS_ESCALATION = BASE + "/CodeSystem/escalation-medium"
# cartridge Device -> its assigned Medication (§5; how meds map to trays)
EXT_DEVICE_MED = BASE + "/StructureDefinition/device-assigned-medication"
# MedicationAdministration valueCode weight|camera|self (§9 verification hierarchy)
EXT_VERIFICATION = BASE + "/StructureDefinition/administration-verification"

# Identifier systems (FHIR-MAPPING.md §7 + §9). The *value* format for dose
# events is defined in schedule.DoseSlot.ident_value — shared with the
# frontend and seed.py.
IDENT_ADMIN = IDENT + "/medication-administration"  # value: request + scheduled occurrence
IDENT_DISPENSE = IDENT + "/medication-dispense"  # value: same slot identity, different system
IDENT_COMM_REQ = IDENT + "/communication-request"  # value: slot identity + "-{rung medium}"
IDENT_REQUEST = IDENT + "/medication-request"  # read to derive the request slug
IDENT_DEVICE = IDENT + "/device"  # read to derive tray numbers ("cartridge-3" -> tray 3)

# Device type codes (local CodeSystem)
DEVICE_CARTRIDGE = "medication-cartridge"
DEVICE_DISPENSER = "pill-dispenser"

# Verification codes, in priority order (FHIR-MAPPING.md §9: weight > camera > self)
VERIFICATIONS = ("weight", "camera", "self")

# Standard HL7 terminology (not project-local): Provenance.agent.type for the
# missed-dose transaction that attributes the write to the dispenser agent.
PROVENANCE_PARTICIPANT_TYPE = "http://terminology.hl7.org/CodeSystem/provenance-participant-type"
