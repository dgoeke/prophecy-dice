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
    };
}
