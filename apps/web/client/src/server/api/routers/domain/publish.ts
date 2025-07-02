import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../../trpc";

export const publishRouter = createTRPCRouter({
    publish: publicProcedure.input(z.object({
        projectId: z.string(),
        domain: z.string(),
    })).mutation(async ({ ctx, input }) => {
        const { projectId, domain } = input;
    }),
}); 