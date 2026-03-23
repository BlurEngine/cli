declare module "picomatch" {
    type PicomatchOptions = {
        dot?: boolean;
    };

    type Matcher = (input: string) => boolean;

    export default function picomatch(
        pattern: string,
        options?: PicomatchOptions,
    ): Matcher;
}
