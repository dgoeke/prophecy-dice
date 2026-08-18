{
  # Prophecy Dice — verifiable prerolled-die ledger (spec/protocol.md §6.8).
  #
  # Lives at the repo root (not /nix/) because a flake cannot reference paths
  # outside its own tree; the NixOS module is in nix/module.nix.
  description = "Prophecy Dice — a verifiable prerolled-die ledger for a tabletop campaign";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: rec {
        # GM service + built UI. Runs via tsx (a devDependency kept in
        # node_modules), so server TypeScript needs no separate compile step.
        column-gm = pkgs.buildNpmPackage {
          pname = "column-gm";
          version = "0.1.0";
          src = ./gm;
          npmDepsHash = "sha256-au6J51zxLaTueWicEJzKSkVcSCdu0+NYhezTgvbr/KE=";
          npmBuildScript = "build";
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontNpmPrune = true; # tsx and vite runtime helpers live in devDeps
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/column
            cp -r dist core server node_modules package.json tsconfig.json $out/lib/column/
            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/column-gm \
              --chdir $out/lib/column \
              --set COLUMN_UI_DIR $out/lib/column/dist \
              --add-flags "--import tsx server/index.ts"
            runHook postInstall
          '';
          meta.description = "the Prophecy Dice GM service (Tailscale interface only — never public)";
        };

        # The player-facing verifier, served next to the published ledger.
        column-verifier = pkgs.runCommand "column-verifier" { } ''
          mkdir -p $out
          cp ${./verifier/verify.html} $out/verify.html
          cp ${./verifier/verify.py} $out/verify.py
        '';

        default = column-gm;
      });

      nixosModules.default = import ./nix/module.nix self;
      nixosModules.column = self.nixosModules.default;

      checks.x86_64-linux.rehearsal-isolation =
        let pkgs = nixpkgs.legacyPackages.x86_64-linux;
        in pkgs.testers.runNixOSTest {
          name = "column-rehearsal-isolation";
          nodes.machine = { lib, ... }: {
            imports = [ self.nixosModules.default ];
            services.column.gm.enable = true;
            services.column.gm.stateDir = "/srv/column-production/state";
            services.column.gm.publicDir = "/srv/column-production/public";
            services.column.gm.autoUnlock.enable = true;
            services.column.gm.autoUnlock.passphraseFile = "/srv/column-production/passphrase";
            services.column.rehearsal.enable = true;
            # Exercise LoadCredential without requiring an initialized campaign
            # in this sandbox-focused VM.
            systemd.services.column-gm.postStart = lib.mkForce ''
              test "$(<"$CREDENTIALS_DIRECTORY/column-passphrase")" = production-passphrase
              ${pkgs.jq}/bin/jq -Rn --rawfile pass "$CREDENTIALS_DIRECTORY/column-passphrase" \
                '{passphrase: $pass}' | ${pkgs.jq}/bin/jq -e '.passphrase == "production-passphrase"' >/dev/null
              touch /srv/column-production/state/credential-ok
            '';
            systemd.tmpfiles.rules = [
              "d /srv/column-production 0755 column column -"
              "f /srv/column-production/passphrase 0644 root root - production-passphrase"
              "d /var/lib/column/mirror 0755 column column -"
              "f /var/lib/column/mirror/id_ed25519 0644 column column - production-key"
              "f /srv/column-production/public/public-ledger 0644 column column - public-test"
            ];
          };
          testScript = ''
            machine.start()
            machine.wait_for_unit("column-gm.service")
            machine.wait_for_unit("column-rehearsal.service")
            machine.succeed("test $(id -u column) != $(id -u column-rehearsal)")
            machine.succeed("test -e /srv/column-production/state/credential-ok")
            machine.succeed("runuser -u column-rehearsal -- test -w /var/lib/column-rehearsal/state")
            machine.succeed("runuser -u column-rehearsal -- test -w /var/lib/column-rehearsal/public")
            # These are intentionally host-readable by the rehearsal UID, so
            # only the service mount namespace can make the assertions pass.
            machine.succeed("runuser -u column-rehearsal -- test -r /srv/column-production/public/public-ledger")
            machine.succeed("runuser -u column-rehearsal -- test -r /var/lib/column/mirror/id_ed25519")
            machine.succeed("runuser -u column-rehearsal -- test -r /srv/column-production/passphrase")
            machine.succeed("pid=$(systemctl show -p MainPID --value column-rehearsal.service); nsenter -t $pid -m -- runuser -u column-rehearsal -- test ! -r /srv/column-production/public/public-ledger")
            machine.succeed("pid=$(systemctl show -p MainPID --value column-rehearsal.service); nsenter -t $pid -m -- runuser -u column-rehearsal -- test ! -r /var/lib/column/mirror/id_ed25519")
            machine.succeed("pid=$(systemctl show -p MainPID --value column-rehearsal.service); nsenter -t $pid -m -- runuser -u column-rehearsal -- test ! -r /srv/column-production/passphrase")
          '';
        };

      checks.x86_64-linux.rehearsal-overlap-rejected =
        let
          pkgs = nixpkgs.legacyPackages.x86_64-linux;
          evaluated = nixpkgs.lib.nixosSystem {
            system = "x86_64-linux";
            modules = [
              self.nixosModules.default
              {
                services.column.rehearsal.enable = true;
                services.column.rehearsal.stateDir = "/var/lib/column/state";
              }
            ];
          };
          rejected = nixpkgs.lib.any
            (assertion: !assertion.assertion && nixpkgs.lib.hasInfix "must not overlap" assertion.message)
            evaluated.config.assertions;
        in assert rejected; pkgs.runCommand "column-rehearsal-overlap-rejected" { } ''
          touch $out
        '';
    };
}
