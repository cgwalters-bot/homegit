.PHONY: all install install-bin install-crates install-dotfiles

all:
	echo "Targets: install install-bin install-crates install-dotfiles"

install: install-bin install-crates install-dotfiles

install-bin:
	./install-bin.sh

# The Rust tools in crates/, into ~/.cargo/bin.
install-crates:
	for c in crates/*/; do cargo install --locked --path "$$c"; done

install-dotfiles:
	./install-dotfiles.sh
