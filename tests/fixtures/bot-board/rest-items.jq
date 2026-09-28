# Items as 'gh project item-list --format json' prints them ({items: [...]},
# as the bot-board tests write their boards) turned into one page of the
# REST Projects v2 items with field values, which bot-board reads.
def select_field($name): {name: $name, data_type: "single_select", value: {name: {raw: .}}};
def text_field($name): {name: $name, data_type: "text", value: {raw: .}};
def capitalized: (.[0:1] | ascii_upcase) + .[1:];
[.items[] | . as $item | {
    node_id: .id,
    content_type: .content.type,
    content: (.content | {node_id: .id, html_url: .url, number, title: $item.title, body}),
    fields: [to_entries[] | .key as $k | .value
        | if $k | IN("status", "priority", "workflow", "org") then select_field($k | capitalized)
          elif $k == "labels" then {name: "Labels", data_type: "labels", value: [to_entries[] | {id: .key, name: .value}]}
          elif $k | IN("id", "title", "content") then empty
          else text_field($k | capitalized) end]}]
