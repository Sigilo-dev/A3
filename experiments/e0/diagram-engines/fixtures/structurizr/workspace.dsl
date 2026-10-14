workspace "A3 synthetic architecture" "Local-only E0-D2 fixture" {
  model {
    editor = person "Editor" "Maintains a local project"
    a3 = softwareSystem "A3" "Local modeling workspace" {
      projectFiles = container "Project files" "JSON and Markdown documents" "Local files"
    }
    editor -> a3 "models"
    editor -> projectFiles "reads and writes"
  }

  views {
    systemContext a3 "context" {
      include *
      autoLayout lr
    }
    container a3 "containers" {
      include *
      autoLayout lr
    }
  }
}
