workspace "A3 local architecture" "Static DSL conversion fixture" {
  model {
    editor = person "Editor" "Maintains the local workspace"
    a3 = softwareSystem "A3" "Project design tool" {
      files = container "Project files" "Markdown and source files" "Local filesystem"
    }
    editor -> a3 "designs"
    editor -> files "edits"
  }
  views {
    systemContext a3 "context" {
      include *
      autoLayout lr
    }
    container a3 "containers" {
      include *
    }
    dynamic a3 "dynamic" {
      editor -> a3 "not converted"
    }
  }
}
