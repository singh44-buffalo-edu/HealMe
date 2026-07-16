"""FHIR constants — mirrors FHIR-MAPPING.md.

Copied (not imported) from ai-service/app/fhir_consts.py: packages never
import across package boundaries in this repo.
"""

BASE = "https://healmedaily.local/fhir"
IDENT = BASE + "/identifier"
CS_ADHERENCE = BASE + "/CodeSystem/adherence-reason"
CS_DEVICE = BASE + "/CodeSystem/device"
CS_ESCALATION = BASE + "/CodeSystem/escalation-medium"
EXT_DEVICE_MED = BASE + "/StructureDefinition/device-assigned-medication"
EXT_VERIFICATION = BASE + "/StructureDefinition/administration-verification"

# Identifier systems (FHIR-MAPPING.md §7 + §9)
IDENT_ADMIN = IDENT + "/medication-administration"
IDENT_DISPENSE = IDENT + "/medication-dispense"
IDENT_COMM_REQ = IDENT + "/communication-request"
IDENT_REQUEST = IDENT + "/medication-request"
IDENT_DEVICE = IDENT + "/device"

# Device type codes (local CodeSystem)
DEVICE_CARTRIDGE = "medication-cartridge"
DEVICE_DISPENSER = "pill-dispenser"

# Verification codes, in priority order (FHIR-MAPPING.md §9: weight > camera > self)
VERIFICATIONS = ("weight", "camera", "self")

PROVENANCE_PARTICIPANT_TYPE = "http://terminology.hl7.org/CodeSystem/provenance-participant-type"
