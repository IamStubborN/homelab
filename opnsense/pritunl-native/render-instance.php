<?php

require_once('/usr/local/opnsense/mvc/script/load_phalcon.php');

if ($argc !== 3) {
    fwrite(STDERR, "Usage: render-instance.php <instance-uuid> <password-file>\n");
    exit(64);
}

$uuid = $argv[1];
$passwordFile = $argv[2];
$usernameFile = '/conf/pritunl-native/secrets/username';

if (!is_readable($usernameFile) || !is_readable($passwordFile)) {
    fwrite(STDERR, "Credential file is not readable.\n");
    exit(66);
}

$username = trim(file_get_contents($usernameFile));
$password = trim(file_get_contents($passwordFile));
if ($username === '' || $password === '') {
    fwrite(STDERR, "Credential value is empty.\n");
    exit(65);
}

$model = new \OPNsense\OpenVPN\OpenVPN();
$node = $model->getNodeByReference("Instances.Instance.{$uuid}");
if ($node === null || (string)$node->role !== 'client') {
    fwrite(STDERR, "OpenVPN client instance was not found.\n");
    exit(69);
}

// Enable only the in-memory model. The persisted instance intentionally stays disabled.
$node->enabled = '1';
$node->username = $username;
$node->password = $password;
$model->generateInstanceConfig($uuid);
