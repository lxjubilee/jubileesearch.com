# Running the Inference API on the workstation

Two per-user scheduled tasks, created without elevation:

```
schtasks /create /f /sc onlogon /rl limited /tn JubileeInferenceAPI    /tr "\"W:\JubileeSearch.com\engine\InferenceAPI\ops\run-inference.cmd\""
schtasks /create /f /sc onlogon /rl limited /tn JubileeInferenceTunnel /tr "\"W:\JubileeSearch.com\engine\InferenceAPI\ops\run-tunnel.cmd\""
schtasks /run /tn JubileeInferenceAPI
schtasks /run /tn JubileeInferenceTunnel
```

They start at logon and each wrapper restarts its process if it exits. Logs:
`inference.log` and `tunnel.log` in this package. Health from here:
`curl http://127.0.0.1:4033/health`; from the production box the same URL
answers over the tunnel.

Configuration is `.env` (not committed): DirectML on adapter 0 (the RTX PRO
6000), fp16 for every role, and `INFERENCE_API_KEY`, which the production
engine carries as the same variable.
