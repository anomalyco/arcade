// Prelude Lab drafts: the whole opening text, typed out on one screen. Grounded, short, no em dashes.
// `align` is the layout each draft was written for (the panel can override it).

export type Draft = { id: string; name: string; align: "center" | "left"; text: string }

export const DRAFTS: Draft[] = [
  {
    id: "prelude",
    name: "Prelude (picked, in the game)",
    align: "center",
    text: [
      "October 19, 1984",
      "",
      "Six researchers work at Ashwood Research Station,",
      "a remote government lab in the mountains.",
      "",
      "On October 17, their radio went silent.",
      "No one has heard from them since.",
      "",
      "You've been sent up there to find out why.",
    ].join("\n"),
  },
  {
    id: "minimal",
    name: "Minimal (3 lines)",
    align: "center",
    text: ["October 19, 1984.", "Ashwood Station has been silent for two days.", "You've been sent to find out why."].join("\n"),
  },
  {
    id: "card",
    name: "Card (today's copy, one screen)",
    align: "center",
    text: [
      "October 19, 1984",
      "Ashwood Station",
      "Interagency Office of Propagation Studies",
      "",
      "The station's radio has been silent for two days.",
      "Nobody answers the phone.",
      "You've been sent to find out why.",
    ].join("\n"),
  },
  {
    id: "narrative",
    name: "Narrative (second person)",
    align: "center",
    text: [
      "1:40 a.m., October 19, 1984.",
      "",
      "Ashwood Station hasn't been on the air in two days.",
      "The phone at the station rings and rings.",
      "Somebody has to drive up there and find out why.",
      "",
      "Tonight, that's you.",
    ].join("\n"),
  },
  {
    id: "log",
    name: "Duty log entry",
    align: "left",
    text: [
      "DUTY LOG          FRI 19 OCT 1984",
      "",
      "0105  Ashwood Station. No radio contact since 17 Oct.",
      "0112  Station telephone rings unanswered. Tried twice.",
      "0130  Field technician dispatched to determine cause.",
    ].join("\n"),
  },
  {
    id: "memo",
    name: "Dispatch memo (TO / FROM / RE)",
    align: "left",
    text: [
      "INTERAGENCY OFFICE OF PROPAGATION STUDIES",
      "FIELD DISPATCH                 No. 84-1019",
      "",
      "TO:     Field Technician, on call",
      "FROM:   Duty Officer, District Office",
      "RE:     Ashwood Station, loss of contact",
      "DATE:   October 19, 1984",
      "",
      "Station radio silent 48 hours.",
      "Telephone rings unanswered.",
      "Proceed to site tonight. Determine cause and report.",
    ].join("\n"),
  },
  {
    id: "teletype",
    name: "Teletype orders",
    align: "left",
    text: [
      "ZCZC IOPS DIST2 NR0419",
      "191984 OCT 0105 EST",
      "TO   FIELD TECH ON CALL",
      "RE   ASHWOOD STATION",
      "",
      "STN RADIO SILENT 48 HRS STOP",
      "LANDLINE NO ANSWER STOP",
      "PROCEED TONIGHT STOP ESTABLISH CAUSE STOP",
      "NNNN",
    ].join("\n"),
  },
]
