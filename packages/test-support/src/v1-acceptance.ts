export * from "./v1-traceability.ts";

import { AuthService, InMemoryAuthStore } from "../../auth/src/index.ts";
import {
  AdministrationService,
  AssistantConfigService,
  InMemoryAdministrationStore,
  InMemoryAssistantRepository,
  InMemoryProfileRepository,
  InMemoryWhatsAppConnections,
  ProfileService,
  WhatsAppConnectionService,
} from "../../domain/src/index.ts";
import {
  DeterministicBaileysDouble,
  DurableLinkCommands,
  EphemeralLinkCodeStore,
  InMemoryInboundRepository,
  InMemorySessionRouter,
  InboundMessageHandler,
  WhatsAppLifecycleManager,
} from "../../../apps/whatsapp-manager/src/index.ts";
import {
  DeterministicOutboundGateway,
  InMemoryOutboundRepository,
  OutboundDispatcher,
} from "../../../apps/whatsapp-manager/src/outbound-dispatcher.ts";
import {
  AiJobProcessor,
  DeterministicAiProvider,
  InMemoryAiJobRepository,
} from "../../../apps/message-worker/src/ai-job.ts";

export interface V1AcceptanceResult {
  businessStatus: "active";
  authenticatedTenant: boolean;
  profileConfigured: boolean;
  assistantActive: boolean;
  whatsappState: "CONNECTED";
  secondLinkRejected: boolean;
  inboundMessages: number;
  aiProvider: "deterministic-ai";
  deliveryState: "sent";
}

export async function runDeterministicV1Journey(): Promise<V1AcceptanceResult> {
  const auth = new AuthService(new InMemoryAuthStore());
  const administration = new AdministrationService(new InMemoryAdministrationStore(), auth);
  const business = await administration.createBusiness({
    name: "Negocio de aceptación",
    userEmail: "acceptance@example.com",
    initialPassword: "correct horse battery staple",
    requestId: "acceptance-admin",
  });
  const session = await auth.login("acceptance@example.com", "correct horse battery staple", 1_000);
  const authenticated = await auth.authenticate(session.token, 1_001);

  const profiles = new ProfileService(new InMemoryProfileRepository());
  profiles.save(business.id, {
    displayName: "Negocio de aceptación",
    description: "Servicios de prueba",
    address: "Dirección segura",
    contact: "Contacto",
    businessHours: "9–18 (informativo)",
    offerings: "Turnos",
    faq: "Preguntas frecuentes",
    policies: "Políticas",
    additionalInfo: "Información autorizada",
  });
  const assistants = new AssistantConfigService(new InMemoryAssistantRepository());
  assistants.save(business.id, {
    personality: "amable",
    tone: "breve",
    instructions: "responder con datos del negocio",
    knowledge: "turnos",
    rules: "sin secretos",
    restrictions: "solo texto",
    active: true,
    expectedRevision: 0,
  });

  const connections = new WhatsAppConnectionService(new InMemoryWhatsAppConnections());
  const baileys = new DeterministicBaileysDouble();
  baileys.script([{ type: "qr", value: "temporary-acceptance-qr" }, { type: "open", linkedNumber: "+549111" }]);
  const commands = new DurableLinkCommands();
  const linkCodes = new EphemeralLinkCodeStore();
  const lifecycle = new WhatsAppLifecycleManager(connections, baileys, commands, linkCodes);
  lifecycle.requestLink(business.id);
  lifecycle.processNext(2_000);
  let secondLinkRejected = false;
  try { lifecycle.requestLink(business.id); }
  catch { secondLinkRejected = true; }
  const connection = connections.claimLease(business.id, "manager-1", 2_001);
  if (connection.state !== "CONNECTED") throw new Error("Acceptance connection did not open");

  const router = new InMemorySessionRouter();
  router.add("acceptance-session", { businessId: business.id, businessStatus: "active", assistantActive: true });
  const inboundRepository = new InMemoryInboundRepository();
  new InboundMessageHandler(router, inboundRepository).handle({
    sessionPublicId: "acceptance-session",
    providerMessageId: "provider-inbound-1",
    remoteJid: "549222@s.whatsapp.net",
    chatType: "individual",
    fromMe: false,
    kind: "text",
    text: "¿Tienen turnos?",
    receivedAt: 2_002,
  });

  const aiRepository = new InMemoryAiJobRepository();
  const ai = new AiJobProcessor(
    new DeterministicAiProvider({ type: "success", text: "Sí, tenemos turnos disponibles." }),
    aiRepository,
  );
  await ai.process({
    businessId: business.id,
    conversationId: "acceptance-conversation",
    messageId: "acceptance-message",
    request: {
      business: { commercialName: "Negocio de aceptación", services: "Turnos" },
      assistant: { personality: "amable", instructions: "responder con datos del negocio" },
      context: { summary: "Sin turnos previos", retrieved: [], recent: ["¿Tienen turnos?"] },
      message: "¿Tienen turnos?",
      maxOutputCharacters: 500,
      correlationId: "acceptance-ai",
    },
  });

  const outboundRepository = new InMemoryOutboundRepository();
  outboundRepository.add({
    outboundId: "acceptance-outbound",
    businessId: business.id,
    connectionId: connection.id,
    remoteJid:"acceptance@s.whatsapp.net",
    text: aiRepository.outbound[0]!.text,
    state: "generated",
  });
  await new OutboundDispatcher(
    outboundRepository,
    new DeterministicOutboundGateway("ack"),
    "manager-1",
  ).dispatch("acceptance-outbound", {
    connectionId: connection.id,
    state: connection.state,
    ownerId: connection.ownerId,
  });

  return {
    businessStatus: "active",
    authenticatedTenant: authenticated?.businessId === business.id,
    profileConfigured: profiles.get(business.id)?.displayName === "Negocio de aceptación",
    assistantActive: assistants.get(business.id)?.active === true,
    whatsappState: "CONNECTED",
    secondLinkRejected,
    inboundMessages: inboundRepository.messages.length,
    aiProvider: "deterministic-ai",
    deliveryState: outboundRepository.get("acceptance-outbound")!.state as "sent",
  };
}
