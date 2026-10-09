.jobs |= map(.name = (if .name == "Restrictions" then "run / policy" elif .name == "Agent" then "run / agent" else "run / check" end))
| .jobs += [{id: 10019, name: "run / apply", status: "completed", conclusion: "success"}]
