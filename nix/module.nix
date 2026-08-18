# NixOS module for Prophecy Dice (spec/protocol.md §6.6–§6.8).
#
# Three processes, hard separation:
#   services.column.gm     — the GM service. Binds ONE address, which must be
#                            the Tailscale IP on a shared server. Holds every
#                            sealed value; never expose it publicly.
#   services.column.rehearsal — an isolated, throwaway GM service with no
#                            mirror and no access to the real campaign state.
#   services.column.public — a Caddy vhost serving publicDir read-only. No key
#                            material, no code path to private state.
#
# TLS for the GM UI: run `tailscale serve https / http://127.0.0.1:7777` (or
# front with tailscale cert) so the unlock passphrase never crosses the
# tailnet in cleartext (§6.6).
self: { config, lib, pkgs, ... }:

let
  cfg = config.services.column;
  inherit (lib) mkEnableOption mkIf mkMerge mkOption types optionalAttrs;
  within = child: parent: let c = toString child; p = toString parent;
    in c == p || lib.hasPrefix "${p}/" c;
  overlaps = a: b: within a b || within b a;
in
{
  options.services.column = {
    gm = {
      enable = mkEnableOption "the Prophecy Dice GM service";

      package = mkOption {
        type = types.package;
        default = self.packages.${pkgs.system}.column-gm;
        description = "The column-gm package (server + built UI).";
      };
      bindAddress = mkOption {
        type = types.str;
        default = "127.0.0.1";
        example = "100.64.0.7";
        description = ''
          Address to bind. On a shared server this MUST be the Tailscale
          interface IP (or 127.0.0.1 behind `tailscale serve`) — never a
          public interface and never 0.0.0.0.
        '';
      };
      port = mkOption { type = types.port; default = 7777; };
      stateDir = mkOption {
        type = types.path;
        default = "/var/lib/column/state";
        description = "Private state: encrypted secret, working ledger, backups. Mode 0700.";
      };
      publicDir = mkOption {
        type = types.path;
        default = "/var/lib/column/public";
        description = "Published artifacts only — written by explicit publish.";
      };
      drandEndpoint = mkOption { type = types.str; default = "https://api.drand.sh"; };
      gitMirrorCommand = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = ''git add ledger.json && (git diff --cached --quiet || git commit -m "publish $COLUMN_PUBLISH_HEAD") && git push'';
        description = ''
          Run in publicDir after each publish. A remote commit history is an
          independent witness only if players can see it and the GM cannot
          quietly rewrite it. Command success is reported, but the
          application cannot prove that the command actually pushed. Failure
          never blocks the local publish. The command receives the frozen
          head as COLUMN_PUBLISH_HEAD and must be idempotent for that head:
          after a process crash, an attempt whose outcome was not durably
          recorded may run again.
        '';
      };
      autoUnlock = {
        enable = mkOption {
          type = types.bool;
          default = false;
          description = ''
            WARNING: auto-unlocking from an on-disk secret makes disk
            compromise total — anyone with the disk has every sealed value of
            the campaign. Manual unlock is one action per boot on a machine
            that reboots monthly. Leave this off unless you have weighed that.
          '';
        };
        passphraseFile = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = "Absolute runtime path containing the passphrase (e.g. an agenix/sops-nix secret path). Injected with systemd LoadCredential.";
        };
      };
    };

    rehearsal = {
      enable = mkEnableOption "an isolated Prophecy Dice rehearsal service";

      package = mkOption {
        type = types.package;
        default = self.packages.${pkgs.system}.column-gm;
        description = "The column-gm package (server + built UI).";
      };
      bindAddress = mkOption {
        type = types.str;
        default = "127.0.0.1";
        description = "Loopback address to bind behind the system reverse proxy.";
      };
      port = mkOption { type = types.port; default = 7778; };
      stateDir = mkOption {
        type = types.path;
        default = "/var/lib/column-rehearsal/state";
        description = "Throwaway rehearsal state. Mode 0700.";
      };
      publicDir = mkOption {
        type = types.path;
        default = "/var/lib/column-rehearsal/public";
        description = "Published rehearsal artifacts, kept separate from the real ledger.";
      };
      drandEndpoint = mkOption { type = types.str; default = "https://api.drand.sh"; };
    };

    public = {
      enable = mkEnableOption "public ledger + verifier vhost (Caddy)";
      domain = mkOption { type = types.str; example = "column.example.org"; };
    };

    backup = {
      enable = mkEnableOption "automated off-box backups of state/";
      onCalendar = mkOption { type = types.str; default = "daily"; };
      command = mkOption {
        type = types.str;
        example = "rsync -a --delete /var/lib/column/state/backups/ backup-host:column-backups/";
        description = ''
          Runs on the timer as the column user. state/private.enc is already
          AES-256-GCM encrypted, so any off-box destination works. Losing
          these backups AND the machine permanently destroys the audit —
          test the restore procedure (README) before session one.
        '';
      };
    };
  };

  config = mkMerge [
    (mkIf cfg.gm.enable {
      assertions = lib.optional (cfg.gm.autoUnlock.passphraseFile != null) {
        assertion = lib.hasPrefix "/" cfg.gm.autoUnlock.passphraseFile;
        message = "services.column.gm.autoUnlock.passphraseFile must be an absolute runtime path";
      };
      users.users.column = { isSystemUser = true; group = "column"; };
      users.groups.column = { };
      # the shared parent is 0755 so a separate static server (caddy) can
      # traverse to publicDir; everything secret lives under stateDir at 0700
      systemd.tmpfiles.rules = [ "d /var/lib/column 0755 column column -" ];
    })

    (mkIf cfg.rehearsal.enable {
      assertions = [
        {
          assertion = !(overlaps cfg.rehearsal.stateDir cfg.rehearsal.publicDir)
            && !(overlaps cfg.rehearsal.stateDir cfg.gm.stateDir)
            && !(overlaps cfg.rehearsal.stateDir cfg.gm.publicDir)
            && !(overlaps cfg.rehearsal.publicDir cfg.gm.stateDir)
            && !(overlaps cfg.rehearsal.publicDir cfg.gm.publicDir)
            && !(within cfg.rehearsal.stateDir "/var/lib/column")
            && !(within cfg.rehearsal.publicDir "/var/lib/column");
          message = "Prophecy Dice rehearsal paths must not overlap or live beneath production /var/lib/column paths.";
        }
      ];
      users.users.column-rehearsal = { isSystemUser = true; group = "column-rehearsal"; };
      users.groups.column-rehearsal = { };
      systemd.tmpfiles.rules = [
        "d /var/lib/column-rehearsal 0755 column-rehearsal column-rehearsal -"
        "d ${cfg.rehearsal.stateDir} 0700 column-rehearsal column-rehearsal -"
        "d ${cfg.rehearsal.publicDir} 0755 column-rehearsal column-rehearsal -"
      ];

      systemd.services.column-rehearsal = {
        description = "Prophecy Dice — isolated rehearsal service";
        wantedBy = [ "multi-user.target" ];
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        preStart = ''
          install -m 0644 ${self.packages.${pkgs.system}.column-verifier}/verify.html \
            ${cfg.rehearsal.publicDir}/verify.html
        '';
        environment = {
          COLUMN_REHEARSAL = "1";
          COLUMN_STATE_DIR = cfg.rehearsal.stateDir;
          COLUMN_PUBLIC_DIR = cfg.rehearsal.publicDir;
          COLUMN_BIND = cfg.rehearsal.bindAddress;
          COLUMN_PORT = toString cfg.rehearsal.port;
          COLUMN_DRAND = cfg.rehearsal.drandEndpoint;
        };
        serviceConfig = {
          ExecStart = "${cfg.rehearsal.package}/bin/column-gm";
          User = "column-rehearsal";
          Group = "column-rehearsal";
          Restart = "on-failure";
          UMask = "0077";
          ProtectSystem = "strict";
          ProtectHome = true;
          PrivateTmp = true;
          NoNewPrivileges = true;
          RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
          ReadWritePaths = [ cfg.rehearsal.stateDir cfg.rehearsal.publicDir ];
          # Hide the entire production tree (including mirror SSH material),
          # any custom production paths, and the configured unlock secret.
          InaccessiblePaths = [ "-/var/lib/column" "-${cfg.gm.stateDir}" "-${cfg.gm.publicDir}" ]
            ++ lib.optional (cfg.gm.autoUnlock.passphraseFile != null) "-${cfg.gm.autoUnlock.passphraseFile}";
          CapabilityBoundingSet = "";
          LockPersonality = true;
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectControlGroups = true;
          RestrictNamespaces = true;
          SystemCallArchitectures = "native";
        };
      };
    })

    (mkIf cfg.gm.enable {

      # the shared parent is 0755 so a separate static server (caddy) can
      # traverse to publicDir; everything secret lives under stateDir at 0700
      systemd.tmpfiles.rules = [
        "d ${cfg.gm.stateDir} 0700 column column -"
        "d ${cfg.gm.publicDir} 0755 column column -"
      ];

      systemd.services.column-gm = {
        description = "Prophecy Dice — GM service (boots locked)";
        wantedBy = [ "multi-user.target" ];
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        # the publish-time git mirror (§6.6) shells out to git over ssh
        path = [ pkgs.git pkgs.openssh ];
        # players audit from the serving URL (§11): keep the verifier copy
        # in publicDir current with the deployed package
        preStart = ''
          install -m 0644 ${self.packages.${pkgs.system}.column-verifier}/verify.html \
            ${cfg.gm.publicDir}/verify.html
        '';
        environment = {
          COLUMN_STATE_DIR = cfg.gm.stateDir;
          COLUMN_PUBLIC_DIR = cfg.gm.publicDir;
          COLUMN_BIND = cfg.gm.bindAddress;
          COLUMN_PORT = toString cfg.gm.port;
          COLUMN_DRAND = cfg.gm.drandEndpoint;
        } // optionalAttrs (cfg.gm.gitMirrorCommand != null) {
          COLUMN_MIRROR_CMD = cfg.gm.gitMirrorCommand;
        };
        serviceConfig = {
          ExecStart = "${cfg.gm.package}/bin/column-gm";
          User = "column";
          Group = "column";
          Restart = "on-failure";
          UMask = "0077";
          # hardening (§6.8)
          ProtectSystem = "strict";
          ProtectHome = true;
          PrivateTmp = true;
          NoNewPrivileges = true;
          RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
          # /var/lib/column also holds mirror ssh material (keys/known_hosts)
          ReadWritePaths = [ "/var/lib/column" cfg.gm.stateDir cfg.gm.publicDir ];
          CapabilityBoundingSet = "";
          LockPersonality = true;
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectControlGroups = true;
          RestrictNamespaces = true;
          SystemCallArchitectures = "native";
        } // optionalAttrs (cfg.gm.autoUnlock.enable && cfg.gm.autoUnlock.passphraseFile != null) {
          LoadCredential = "column-passphrase:${cfg.gm.autoUnlock.passphraseFile}";
        };
        # off by default; see the option warning (§6.4)
        postStart = mkIf (cfg.gm.autoUnlock.enable && cfg.gm.autoUnlock.passphraseFile != null) ''
          sleep 2
          ${pkgs.jq}/bin/jq -Rn --rawfile pass "''${CREDENTIALS_DIRECTORY}/column-passphrase" \
            '{passphrase: $pass}' | ${pkgs.curl}/bin/curl -sf -X POST \
            -H 'Content-Type: application/json' \
            --data-binary @- \
            "http://${cfg.gm.bindAddress}:${toString cfg.gm.port}/api/unlock" > /dev/null
        '';
      };
    })

    (mkIf cfg.public.enable {
      # A separate static file server on the public interface. It can read
      # ONLY publicDir: no key material, no route to state/ (§6.6, §12.10).
      services.caddy.enable = true;
      services.caddy.virtualHosts.${cfg.public.domain}.extraConfig = ''
        root * ${cfg.gm.publicDir}
        file_server
        header /ledger.json Cache-Control "no-cache"
      '';
    })

    (mkIf cfg.backup.enable {
      systemd.services.column-backup = {
        description = "Prophecy Dice — off-box state backup";
        script = cfg.backup.command;
        serviceConfig = { Type = "oneshot"; User = "column"; Group = "column"; };
      };
      systemd.timers.column-backup = {
        wantedBy = [ "timers.target" ];
        timerConfig = { OnCalendar = cfg.backup.onCalendar; Persistent = true; };
      };
    })
  ];
}
